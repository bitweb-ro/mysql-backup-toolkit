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

Tot din **Opțiuni** → „Alertă spațiu pe disc” se poate seta o limită minimă de spațiu liber (în GB). După terminarea fiecărui backup (manual sau programat, reușit sau eșuat) se verifică spațiul liber pe discul folderului de backup (`BACKUP_PATH`); dacă scade sub limită se trimite o alertă pe Slack — o singură dată, nu după fiecare backup — și un mesaj când spațiul revine peste limită. Gol sau 0 = dezactivat. Spațiul disponibil (liber / total / procent folosit) este afișat și în **Dashboard**, cu avertizare vizuală când e sub limită.

Dacă niciun webhook nu este configurat, nu se trimite nimic. Webhook-ul setat din UI este salvat în baza de date internă; alternativ, poate fi furnizat prin variabila de mediu `SLACK_WEBHOOK_URL` (valoarea din UI are prioritate). Butonul „Trimite test” validează că webhook-ul răspunde.

**Webhook per server**: pagina serverului → tab-ul **⚙️ Setări** → „Notificări Slack”. Dacă e completat, alertele acelui server (backup / upload / restaurare eșuate) merg pe acest webhook **în locul** celui global (ex: un canal separat per client). Gol = se folosește webhook-ul global. Alerta de spațiu pe disc și erorile fatale ale aplicației merg mereu pe webhook-ul global.

### Pagina unui server

Click pe un server (în sidebar sau în Dashboard) deschide pagina lui, cu tab-urile:

- **📊 Dashboard**: ultimul full, incrementalele de azi, backup-uri reușite / eșuate (7 zile), programul, destinația backup-urilor, ultimele 10 rulări;
- **📦 Backup**, **↩ Restore**, **🕐 Program**: ca înainte;
- **⚙️ Setări**: configurări proprii serverului (destinația backup-urilor, webhook Slack), care suprascriu setările globale din Opțiuni.

Lista de servere (sidebar și Dashboard) se actualizează imediat după adăugare, editare, ștergere sau import, fără refresh.

Bulina din dreptul fiecărui server din sidebar arată starea după ultimul backup reușit (full sau incremental); legenda e sub listă:

- 🟡 galben: backup în curs;
- 🟢 verde: backup în ultimele 48h;
- 🟣 mov: niciun backup de peste 48h;
- 🔴 roșu: niciun backup de peste 7 zile sau niciodată.

### Destinația backup-urilor (local / SFTP / FTP / S3)

Backup-urile pot fi trimise, pe lângă disc, pe o destinație remote:

- **Local**: implicit, doar folderul `backup_servers/`.
- **SFTP / SSH**: autentificare cu parolă sau cheie privată (OpenSSH/PEM, opțional cu passphrase).
- **FTP / FTPS**: FTPS = TLS explicit, recomandat (FTP simplu trimite parola necriptat).
- **S3**: AWS S3 sau orice serviciu S3-compatibil (MinIO, Backblaze B2, Hetzner, Wasabi etc.) prin câmpul „Endpoint”. Bifa „Path-style URL” e necesară pentru MinIO și unii furnizori.

Configurare:

- **Destinația implicită**: sidebar → **Opțiuni** → tab-ul „Stocare backup”. Se aplică tuturor serverelor fără configurare proprie.
- **Per server**: pagina serverului → tab-ul **⚙️ Setări** → „Stocare backup” → „Destinație proprie pentru acest server”. „Folosește destinația implicită” revine la setarea din Opțiuni.
- La salvare / testare, câmpurile obligatorii necompletate sunt marcate cu roșu.
- Butonul „Testează conexiunea” urcă și șterge un fișier mic de test (`.mysql-backup-test_*`) în directorul / prefixul configurat.

Cum funcționează:

- Backup-ul (manual sau programat) se face întâi local, apoi fișierul se urcă la `<director remote sau prefix S3>/<nume_server>/<full|incremental>/<fișier>`, aceeași structură ca local.
- „Păstrează și copia locală” bifat: fișierul rămâne și pe disc. Debifat: se șterge local după upload reușit.
- **Upload eșuat**: backup-ul rămâne reușit, fișierul local se păstrează (indiferent de bifă), eroarea apare în lista de backup-uri și se trimite o alertă 🟠 pe Slack.
- Restaurarea și descărcarea unui backup aflat doar remote îl descarcă temporar în `backup_servers/.tmp/`, apoi îl șterg.
- Ștergerea unui backup (manual, prin retenție sau la ștergerea serverului) șterge și fișierul remote. Dacă fișierul remote nu poate fi șters, înregistrarea se șterge oricum și eroarea se afișează / se scrie în log.
- Pentru backup-urile remote existente se folosesc credențialele destinației curente de același tip (a serverului, apoi cea implicită). Dacă schimbi tipul destinației (ex: din SFTP în S3), backup-urile vechi de pe SFTP nu mai pot fi descărcate / restaurate / șterse din aplicație până nu reconfigurezi SFTP.
- Schimbarea destinației se aplică de la următorul backup. Fișierele existente nu se mută.
- Exportul de configurație include și destinația proprie a fiecărui server (cu credențialele), iar importul o preia.

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

SQLite (`backend/data/app.db`) — conține conexiunile (inclusiv destinația proprie de backup a fiecărui server), istoricul backup-urilor (inclusiv unde e salvat fiecare fișier: local / SFTP / FTP / S3), programările (schedules) și setările platformei (ex. webhook-ul Slack, limita de alertă pentru spațiul pe disc, destinația implicită a backup-urilor). Fișierele de backup propriu-zise sunt în `backup_servers/` și/sau pe destinația remote.

## Cerințe pentru serverul MySQL backup-uit

- Binary logging activat (`log_bin = ON`, implicit în MySQL 8).
- User dedicat cu privilegii: `SELECT, RELOAD, LOCK TABLES, REPLICATION CLIENT, REPLICATION SLAVE, SHOW DATABASES, SHOW VIEW, PROCESS`.

## Note de securitate

- Parolele MySQL și credențialele destinațiilor de backup (parole SFTP/FTP, chei SSH, chei S3) sunt stocate în SQLite, neencriptate — restricționează accesul la `data/app.db`. În UI, secretele salvate nu se mai afișează (apar mascate).
- Pentru destinațiile remote folosește un user dedicat, cu acces doar la directorul / bucket-ul de backup.
- Expune aplicația doar pe loopback sau în spatele unui reverse proxy autentificat (nginx, etc.).
