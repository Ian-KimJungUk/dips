#!/usr/bin/env bash
# blue/green 무중단 배포
# 사용법: ./deploy.sh <이미지 태그>   예) ./deploy.sh sha-1a2b3c4
#
# 1. 이미지 pull  2. migrate  3. 대기 중인 색(blue/green)에 새 버전 기동
# 4. /health 확인 → 실패하면 새 컨테이너만 정리하고 종료 (기존 버전이 계속 서비스)
# 5. nginx 트래픽 전환  6. 이전 버전 종료
set -euo pipefail
cd "$(dirname "$0")"

TAG=${1:?이미지 태그가 필요합니다 (예: sha-1a2b3c4)}
export APP_IMAGE=${APP_IMAGE:-ghcr.io/ian-kimjunguk/dips}
export MIGRATE_IMAGE=${MIGRATE_IMAGE:-ghcr.io/ian-kimjunguk/dips-migrate}

# 현재 상태. .env는 compose도 자동으로 읽어 각 색의 이미지 태그로 사용
ACTIVE=none BLUE_TAG=none GREEN_TAG=none
if [ -f .env ]; then source .env; fi
export BLUE_TAG GREEN_TAG

OLD=$ACTIVE
if [ "$OLD" = blue ]; then NEW=green; else NEW=blue; fi

echo "==> [1/6] 이미지 pull ($TAG)"
docker pull -q "$APP_IMAGE:$TAG"
docker pull -q "$MIGRATE_IMAGE:$TAG"

echo "==> [2/6] 마이그레이션"
docker compose up -d redis
if ! DEPLOY_TAG=$TAG docker compose run --rm migrate; then
  echo "!! 마이그레이션 실패 → 배포 중단 (app-$OLD 계속 서비스)" >&2
  exit 1
fi

echo "==> [3/6] app-$NEW 기동 (현재 서비스: $OLD)"
if [ "$NEW" = blue ]; then export BLUE_TAG=$TAG; else export GREEN_TAG=$TAG; fi
docker compose up -d --force-recreate "app-$NEW"

echo "==> [4/6] app-$NEW 헬스체크"
healthy=false
for _ in $(seq 1 30); do
  if docker compose exec -T "app-$NEW" wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if [ "$healthy" != true ]; then
  echo "!! app-$NEW 헬스체크 실패 → 트래픽 전환하지 않음 (app-$OLD 계속 서비스)" >&2
  docker compose logs --tail 50 "app-$NEW" >&2 || true
  docker compose rm -sf "app-$NEW"
  exit 1
fi

echo "==> [5/6] nginx 트래픽 전환 → app-$NEW"
echo "set \$app_upstream app-$NEW;" > nginx/active.inc
docker compose up -d nginx
docker compose exec -T nginx nginx -s reload

ACTIVE=$NEW
cat > .env <<EOF
ACTIVE=$ACTIVE
BLUE_TAG=$BLUE_TAG
GREEN_TAG=$GREEN_TAG
EOF

if [ "$OLD" != none ]; then
  echo "==> [6/6] app-$OLD 종료"
  # reload 전 nginx 워커가 처리 중이던 요청을 마칠 시간
  sleep 5
  docker compose stop -t 30 "app-$OLD"
fi

echo "==> 배포 완료: app-$NEW ($TAG)"
