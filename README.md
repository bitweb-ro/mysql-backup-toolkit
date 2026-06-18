# MySQL Backup Manager

Aplicație self-hosted (Node.js + TypeScript + React) pentru backup și restore MySQL 8.0 — full (mysqldump) și incremental (binlog), cu programare automată, rulată complet în Docker.

## Ce face

- Gestionează mai multe conexiuni MySQL (locale sau remote) dintr-o singură interfață.
- **Backup full** — `mysqldump --single-transaction --flush-logs`.
- **Backup incremental** — extrage binlog-urile MySQL apărute de la ultimul backup (suportă citire directă din fișiere locale sau via protocol remote, dacă serverul MySQL e pe alt host).
- **Programare automată** (scheduling) pentru rulare periodică a backup-urilor, fără cron extern.
- **Restore** — full (`gunzip | mysql`) și incremental (replay binlog), cu confirmare explicită.
- Istoric backup-uri per conexiune, cu jurnal de execuție și status (success/failed/running).

## Rulare (Docker, recomandat)

```bash
docker-compose up --build -d
# Aplicația pornește pe http://localhost:3001
```

Conține serviciul `app` (backend + frontend buildate împreună) și, opțional, `mysql` (server local, doar pentru testare — nu e necesar dacă backup-uiești exclusiv servere externe). Containerul `app` include propriile binare `mysql`, `mysqldump`, `mysqlbinlog` — nu necesită nimic instalat pe host.

Serviciul `mysql` nu pornește implicit; pornește-l explicit doar dacă ai nevoie de un server de test local:

```bash
docker-compose --profile local-mysql up --build -d
```

> Pe Mac Apple Silicon (arm64), `app` rulează sub emulare `linux/amd64` (Rosetta), deoarece binarele oficiale MySQL 8.0 client compatibile cu formatul GTID sunt publicate doar pentru amd64.

> Pe servere/CPU-uri vechi (sau cu virtualizare ce restricționează setul de instrucțiuni — model CPU virtual `qemu64` etc.) poți întâlni la pornire `Fatal glibc error: CPU does not support x86-64-v2`. E o cerință hardware a build-urilor recente Debian/Oracle Linux folosite de imaginea oficială MySQL, nu un bug al aplicației. Dacă apare la serviciul `mysql` (local, opțional), pur și simplu nu îl pornești (vezi mai sus). Dacă apare și la `app` când rulează `mysqldump`/`mysqlbinlog`, CPU-ul/virtualizarea nu suportă seturile de instrucțiuni necesare — soluția e un host cu CPU mai nou sau cu modelul de CPU virtual setat la `host`/`kvm64`.

Pentru development cu hot-reload: `docker-compose -f docker-compose.dev.yml up --build`.

### Porturi

Porturile expuse pe host sunt configurabile din `.env` (`PORT_APP_FRONTEND`, `PORT_APP_BACKEND`, `PORT_APP_MYSQL`) — utile dacă porturile implicite (3000/3001/3306) sunt deja ocupate pe server.

### Locația fișierelor de backup pe disc

Folderul `backup_servers/` este montat ca bind mount (nu volum Docker intern), deci e accesibil direct din host. Implicit e `./backup_servers`, lângă `docker-compose.yml`. Poate fi schimbat cu variabila `BACKUP_PATH` din `.env` (util când discul local nu are spațiu suficient, ex. `BACKUP_PATH=/mnt/backup-disk`).

### Notificări Slack (opțional)

Din sidebar → **Opțiuni** → secțiunea „Notificări Slack” se poate configura un [Slack Incoming Webhook](https://api.slack.com/messaging/webhooks). Dacă este configurat, aplicația trimite un mesaj prin POST la webhook pentru orice problemă de backup:

- backup eșuat (manual sau programat, full sau incremental);
- restaurare eșuată;
- eroare fatală a aplicației (`uncaughtException` / `unhandledRejection`).

Dacă niciun webhook nu este configurat, nu se trimite nimic. Webhook-ul setat din UI este salvat în baza de date internă; alternativ, poate fi furnizat prin variabila de mediu `SLACK_WEBHOOK_URL` (valoarea din UI are prioritate). Butonul „Trimite test” validează că webhook-ul răspunde.

## Structura fișierelor de backup

```
backup_servers/
  nume_server/
    full/
      full_2026-06-13T10-00-00-000Z.sql.gz
    incremental/
      incremental_2026-06-13T12-00-00-000Z.sql.gz
```

Numele folderului per server e derivat din numele conexiunii: litere mici, diacritice românești convertite la litere de bază (ă/â→a, î→i, ș→s, ț→t), restul caracterelor non alfanumerice înlocuite cu `_`. Ex: „Server Producție #1” → `server_productie_1`. Schimbarea numelui unei conexiuni existente generează un folder nou la următorul backup — fișierele vechi nu se mută automat.

## Baza de date internă

SQLite (`backend/data/app.db`) — conține conexiunile, istoricul backup-urilor, programările (schedules) și setările platformei (ex. webhook-ul Slack). Fișierele de backup propriu-zise sunt în `backup_servers/`.

## Cerințe pentru serverul MySQL backup-uit

- Binary logging activat (`log_bin = ON`, implicit în MySQL 8).
- User dedicat cu privilegii: `SELECT, RELOAD, LOCK TABLES, REPLICATION CLIENT, REPLICATION SLAVE, SHOW DATABASES, SHOW VIEW, PROCESS`.

## Note de securitate

- Parolele MySQL sunt stocate în SQLite, neencriptate — restricționează accesul la `data/app.db`.
- Expune aplicația doar pe loopback sau în spatele unui reverse proxy autentificat (nginx, etc.).
