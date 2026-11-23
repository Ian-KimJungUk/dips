# EC2 배포

EC2 한 대에서 nginx + blue/green으로 무중단 배포한다. Postgres는 RDS, Redis는 EC2 컨테이너.

```
요청 → nginx(:80) → app-blue 또는 app-green (한쪽만 트래픽)
                    redis
                    (RDS) ← DATABASE_URL
```

## 배포 흐름 (`deploy.sh <태그>`)

1. 앱 이미지, migrate 이미지 pull (`ghcr.io/ian-kimjunguk/dips[-migrate]:<태그>`)
2. 마이그레이션 실행 → 실패하면 중단 (기존 버전 계속 서비스)
3. 대기 중인 색에 새 버전 기동
4. `/health` 확인 (최대 60초) → 실패하면 새 컨테이너만 정리하고 중단 (기존 버전 계속 서비스)
5. nginx 트래픽 전환 (reload, 연결 끊김 없음)
6. 이전 버전 종료

현재 상태(어느 색이 서비스 중인지, 각 색의 태그)는 `deploy/.env`에 기록된다.

## 주의: 마이그레이션은 이전 버전과 호환되게

전환 직전까지 이전 버전 앱이 새 스키마 위에서 돌고, DB는 롤백되지 않는다.

- 가능: 테이블/컬럼 추가 (새 컬럼은 nullable 또는 기본값)
- 다음 배포로 미룰 것: 컬럼 삭제, 이름 변경, 타입 변경

## EC2 최초 설정

1. Docker + compose 플러그인 설치
2. 이 `deploy/` 디렉터리를 서버에 복사 (예: `/opt/dips`)
3. `cp app.env.example app.env` 후 RDS 접속 정보 입력
4. 보안 그룹: 80 인바운드 허용, RDS 보안 그룹에서 EC2 접근 허용

`deploy/` 파일(compose.yml, nginx, deploy.sh)이 바뀌면 서버에도 다시 복사해야 한다. CD는 서버에 있는 `deploy.sh`를 실행할 뿐 파일을 갱신하지 않는다.

## CD (GitHub Actions → SSM → deploy.sh)

`.github/workflows/cd.yml`: main CI 성공 → `production` 환경 승인 → SSM으로 EC2에서 `deploy.sh sha-<커밋>` 실행.

### AWS 설정

1. IAM > 자격 증명 공급자: OpenID Connect 추가
   - URL `https://token.actions.githubusercontent.com`, 대상 `sts.amazonaws.com`
2. IAM 역할 생성 (GitHub Actions가 assume)
   - 신뢰 정책:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": { "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
           "token.actions.githubusercontent.com:sub": "repo:Ian-KimJungUk/dips:environment:production"
         } }
       }]
     }
     ```
   - 권한 정책:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         { "Effect": "Allow", "Action": "ssm:SendCommand", "Resource": [
           "arn:aws:ec2:<REGION>:<ACCOUNT_ID>:instance/<INSTANCE_ID>",
           "arn:aws:ssm:<REGION>::document/AWS-RunShellScript"
         ] },
         { "Effect": "Allow", "Action": "ssm:GetCommandInvocation", "Resource": "*" }
       ]
     }
     ```
3. EC2 인스턴스 프로파일에 `AmazonSSMManagedInstanceCore` 연결 (Amazon Linux 2023은 SSM agent 기본 설치)

### GitHub 설정

1. Settings > Environments > `production` 생성, Required reviewers에 승인자 지정
2. Settings > Secrets and variables > Actions > Variables
   - `AWS_ROLE_ARN`: 위 IAM 역할 ARN
   - `AWS_REGION`: 예) `ap-northeast-2`
   - `EC2_INSTANCE_ID`: 예) `i-0123456789abcdef0`
   - `DEPLOY_DIR` (선택, 기본 `/opt/dips`)

## 수동 배포 / 롤백

GitHub Actions > CD > Run workflow 에서 태그(`sha-1a2b3c4`) 입력. 또는 서버에서 직접:

```sh
./deploy.sh sha-1a2b3c4      # 배포
./deploy.sh sha-<이전 커밋>   # 롤백도 같은 방식 (무중단)
```
