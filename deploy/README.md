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

## 수동 배포 / 롤백

```sh
./deploy.sh sha-1a2b3c4      # 배포
./deploy.sh sha-<이전 커밋>   # 롤백도 같은 방식 (무중단)
```
