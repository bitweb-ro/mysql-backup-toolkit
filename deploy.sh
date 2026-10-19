#!/usr/bin/env bash
# Deploy MySQL Backup Manager pe server. Codul sursă nu rămâne pe server: se urcă într-un
# folder temporar (.build/), se construiește imaginea Docker, se pornește aplicația și
# folderul se șterge. Containerul rulează din imagine; la restart server îl repornește Docker.
#
# Ce rămâne pe server (REMOTE_ROOT):
#   .env              setările de producție — NU se atinge
#   backup_servers/   fișierele de backup (BACKUP_PATH, cale absolută) — NU se atinge
#   db-backups/       copie a bazei SQLite (app.db) făcută înainte de fiecare deploy
# Baza SQLite stă în volumul Docker <PROJECT>_app_data și se păstrează.
#
# Se urcă copia locală curentă (inclusiv modificările necomise), fără ce e în .gitignore
# (.env, node_modules, backup_servers, CLAUDE.md, .claude).
#
# Utilizare: ./deploy.sh [-y]        (-y = fără confirmare)
# Țintă diferită: DEPLOY_HOST=user@ip REMOTE_ROOT=/cale ./deploy.sh

set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-valmotor2@192.168.100.10}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/valmotor2/mysql-backup-toolkit}"
# Numele proiectului compose. Trebuie să rămână același, altfel se creează un volum nou și gol pentru app.db.
PROJECT="mysql-backup-toolkit"
KEEP_DB_BACKUPS=10

cd "$(dirname "$0")"

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f docker-compose.yml ] && [ -f Dockerfile ] || die "Rulează scriptul din rădăcina proiectului."
command -v git >/dev/null || die "git nu este instalat."

if [ "${1:-}" != "-y" ]; then
  printf 'Deploy pe \033[1m%s:%s\033[0m (codul de pe server se șterge, datele rămân). Continui? [y/N] ' "$DEPLOY_HOST" "$REMOTE_ROOT"
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "Anulat."
fi

# ─── 1. Verificări pe server ──────────────────────────────────────
say "Verificare server"
set +e
ssh -o BatchMode=yes "$DEPLOY_HOST" bash -s -- "$REMOTE_ROOT" <<'REMOTE'
set -euo pipefail
ROOT="$1"
command -v docker >/dev/null || { echo "Docker nu este instalat pe server."; exit 1; }
docker compose version >/dev/null || { echo "docker compose (v2) lipsește pe server."; exit 1; }
[ -f "$ROOT/.env" ] || { echo "Lipsește $ROOT/.env (setările de producție). Creează-l pornind de la .env.example."; exit 1; }
# Codul vechi (structura dinainte de app/) și folderul rădăcină sunt create de root: e nevoie de chown o singură dată.
for p in "$ROOT" "$ROOT/.env" "$ROOT/backend" "$ROOT/frontend" "$ROOT/.git" "$ROOT/app"; do
  if [ -e "$p" ] && [ "$(stat -c %U "$p")" != "$(whoami)" ]; then exit 3; fi
done
exit 0
REMOTE
status=$?
set -e
if [ "$status" = 3 ]; then
  echo "Folderul $REMOTE_ROOT aparține lui root. E nevoie o singură dată de:"
  echo "  sudo chown -R \$(whoami): $REMOTE_ROOT"
  printf 'Rulez acum (cere parola sudo pe server)? [y/N] '
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "Anulat. Rulează comanda de mai sus pe server, apoi din nou ./deploy.sh."
  ssh -t "$DEPLOY_HOST" "sudo chown -R \$(whoami): '$REMOTE_ROOT'"
elif [ "$status" != 0 ]; then
  die "Verificarea serverului a eșuat."
fi

# ─── 2. Arhivă cu codul local ─────────────────────────────────────
say "Împachetare cod local"
TARBALL="$(mktemp -t mbm-deploy.XXXXXX)"
trap 'rm -f "$TARBALL"' EXIT
# Fișiere urmărite + fișiere noi care nu sunt în .gitignore; fără cele șterse local.
# --no-xattrs / --no-mac-metadata: fără atributele macOS (ex: com.apple.provenance),
# pe care tar-ul de pe Linux le raportează ca „unknown extended header keyword”.
git ls-files -co --exclude-standard | while IFS= read -r f; do
  [ -e "$f" ] && printf '%s\0' "$f"
done | COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --null -T - -czf "$TARBALL"
echo "Arhivă: $(du -h "$TARBALL" | cut -f1)"

# ─── 3. Upload în folderul temporar .build (aplicația veche rulează în continuare) ─
say "Upload pe server"
ssh -o BatchMode=yes "$DEPLOY_HOST" "rm -rf '$REMOTE_ROOT/.build' && mkdir -p '$REMOTE_ROOT/.build' && tar -xzf - -C '$REMOTE_ROOT/.build'" < "$TARBALL"

# ─── 4. Build, oprire, copie DB, pornire, ștergere cod ───────────
ssh -o BatchMode=yes "$DEPLOY_HOST" bash -s -- "$REMOTE_ROOT" "$PROJECT" "$KEEP_DB_BACKUPS" <<'REMOTE'
set -euo pipefail
ROOT="$1"; PROJECT="$2"; KEEP="$3"
BUILD="$ROOT/.build"; ENV="$ROOT/.env"
TS="$(date +%Y%m%d-%H%M%S)"
# Codul sursă se șterge la final, inclusiv dacă deploy-ul eșuează.
trap 'rm -rf "$BUILD"' EXIT
say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
compose() { docker compose -p "$PROJECT" --env-file "$ENV" -f "$BUILD/docker-compose.yml" "$@"; }

# BACKUP_PATH trebuie să fie absolut și în afara codului, altfel backup-urile s-ar șterge la deploy.
say "Verificare BACKUP_PATH"
bp="$(grep -E '^BACKUP_PATH=' "$ENV" | tail -1 | cut -d= -f2- | tr -d "\"'" || true)"
if [ -z "$bp" ] || [ "$bp" = "./backup_servers" ] || [ "$bp" = "backup_servers" ]; then
  # Structura veche: compose rula din $ROOT, deci ./backup_servers era $ROOT/backup_servers.
  cp "$ENV" "$ENV.bak-$TS"
  if grep -qE '^BACKUP_PATH=' "$ENV"; then
    sed -i "s|^BACKUP_PATH=.*|BACKUP_PATH=$ROOT/backup_servers|" "$ENV"
  else
    printf '\nBACKUP_PATH=%s\n' "$ROOT/backup_servers" >> "$ENV"
  fi
  bp="$ROOT/backup_servers"
  echo "BACKUP_PATH setat la $bp (copie a .env: .env.bak-$TS)"
fi
case "$bp" in /*) ;; *) die "BACKUP_PATH=$bp trebuie să fie o cale absolută.";; esac
case "$bp/" in "$BUILD/"*|"$ROOT/app/"*) die "BACKUP_PATH=$bp este în folderul de cod și s-ar șterge la deploy.";; esac
mkdir -p "$bp"
echo "Backup-uri: $bp ($(du -sh "$bp" | cut -f1))"

say "Build imagine nouă (aplicația veche rulează încă)"
compose build --pull app

say "Oprire aplicație veche"
compose down --remove-orphans

say "Copie baza SQLite (app.db) în $ROOT/db-backups"
mkdir -p "$ROOT/db-backups"
if docker volume inspect "${PROJECT}_app_data" >/dev/null 2>&1; then
  docker run --rm --entrypoint sh \
    -v "${PROJECT}_app_data:/data:ro" -v "$ROOT/db-backups:/out" \
    "${PROJECT}-app" -c "cd /data && ls app.db* >/dev/null 2>&1 && mkdir /out/app-$TS && cp -a app.db* /out/app-$TS/ || echo 'Nu există încă app.db.'"
  { ls -1dt "$ROOT"/db-backups/app-* 2>/dev/null || true; } | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
else
  echo "Volumul ${PROJECT}_app_data nu există încă (prima instalare)."
fi

say "Ștergere cod vechi de pe server"
# Structurile vechi: cod direct în $ROOT sau în app/ (doar nume cunoscute; .env, backup_servers, db-backups rămân).
for old in app app.new backend frontend mysql-config .git Dockerfile docker-compose.yml docker-compose.dev.yml \
           .dockerignore .env.example .gitignore package.json README.md deploy.sh; do
  rm -rf "${ROOT:?}/$old"
done

say "Pornire aplicație nouă"
compose up -d app

printf 'Aștept starea healthy'
for _ in $(seq 1 40); do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mysql-backup-app 2>/dev/null || echo missing)"
  [ "$state" = "healthy" ] && break
  [ "$state" = "exited" ] || [ "$state" = "missing" ] && break
  printf '.'; sleep 3
done
echo " $state"
docker logs --tail 15 mysql-backup-app 2>&1
[ "$state" = "healthy" ] || die "Aplicația nu a pornit corect (stare: $state). Copia bazei e în $ROOT/db-backups/app-$TS."

say "Curățare imagini vechi ale proiectului"
docker image prune -f --filter "label=com.docker.compose.project=$PROJECT" >/dev/null
echo "Gata. Pe server au rămas:"
ls -A "$ROOT"
REMOTE

say "Deploy reușit pe $DEPLOY_HOST"
