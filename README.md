# MySQL Backup Manager

Aplicație self-hosted (Node.js + TypeScript + React) pentru backup și restore MySQL 8.0 — full (mysqldump) și incremental (binlog), cu programare automată, rulată complet în Docker.

## Ce face

- Gestionează mai multe conexiuni MySQL (locale sau remote) dintr-o singură interfață.
- **Backup full** — `mysqldump --single-transaction --flush-logs`.
- **Backup incremental** — extrage binlog-urile MySQL apărute de la ultimul backup (suportă citire directă din fișiere locale sau via protocol remote, dacă serverul MySQL e pe alt host).
- **Programare automată** (scheduling) pentru rulare periodică a backup-urilor, fără cron extern.
- **Restore** — full (`gunzip | mysql`) și incremental (replay binlog), cu confirmare explicită. Un backup full se poate restaura și într-o **altă bază** de pe același server, pentru verificare (vezi „Restaurare de verificare”).
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

Serverul de test e MySQL 8.4 (LTS), cu o configurație (`mysql-config/binlog.cnf`) valabilă și pe 8.0 / 9.x. Pentru teste pe altă versiune: `MYSQL_TEST_IMAGE=mysql:8.0` în `.env`. Un volum deja actualizat la 8.4 nu mai poate fi pornit cu 8.0: șterge întâi volumul serverului de test. Uneltele din containerul `app` (mysqldump, mysqlbinlog) sunt clientul MySQL 8.0 și funcționează cu servere 8.0, 8.4 și MariaDB.

> Pe Mac Apple Silicon (arm64), `app` rulează sub emulare `linux/amd64` (Rosetta), deoarece binarele oficiale MySQL 8.0 client compatibile cu formatul GTID sunt publicate doar pentru amd64.

> Pe servere/CPU-uri vechi (sau cu virtualizare ce restricționează setul de instrucțiuni — model CPU virtual `qemu64` etc.) poți întâlni la pornire `Fatal glibc error: CPU does not support x86-64-v2`. E o cerință hardware a build-urilor recente Debian/Oracle Linux folosite de imaginea oficială MySQL, nu un bug al aplicației. Dacă apare la serviciul `mysql` (local, opțional), pur și simplu nu îl pornești (vezi mai sus). Dacă apare și la `app` când rulează `mysqldump`/`mysqlbinlog`, CPU-ul/virtualizarea nu suportă seturile de instrucțiuni necesare — soluția e un host cu CPU mai nou sau cu modelul de CPU virtual setat la `host`/`kvm64`.

Pentru development cu hot-reload: `docker-compose -f docker-compose.dev.yml up --build`.

> Verifică întâi `docker context show`: trebuie să fie Docker-ul local (`desktop-linux` / `default`). Dacă e un context SSH către un server, stack-ul de dev pornește **pe acel server**: containerele nu găsesc `package.json` (folderele `./backend`, `./frontend` nu există acolo), iar MySQL-ul de test se publică pe portul 3306 al serverului. Mai sigur: `docker --context desktop-linux compose -f docker-compose.dev.yml up --build`.

### Deploy pe server (`deploy.sh`)

```bash
./deploy.sh          # cere confirmare
./deploy.sh -y       # fără confirmare
DEPLOY_HOST=user@ip REMOTE_ROOT=/cale ./deploy.sh   # altă țintă (implicit valmotor2@192.168.100.10)
```

La fiecare rulare codul de pe server se șterge și se rescrie cu copia locală curentă (inclusiv modificările necomise; fără ce e în `.gitignore`). Datele rămân:

```
~/mysql-backup-toolkit/
├── .env              setările de producție — nu se atinge
├── backup_servers/   fișierele de backup (BACKUP_PATH, cale absolută) — nu se atinge
├── db-backups/       copie a app.db înainte de fiecare deploy (ultimele 10)
└── app/              codul — șters și rescris la fiecare deploy
```

Pași: upload în `app.new/` → build imagine (aplicația veche rulează încă; dacă build-ul eșuează, nu se oprește nimic) → oprire aplicație veche → copie `app.db` → înlocuire cod → pornire → așteptare stare `healthy`. Baza SQLite stă în volumul Docker `mysql-backup-toolkit_app_data`.

Prima rulare pe un server cu structura veche (cod direct în `~/mysql-backup-toolkit`, creat de root): scriptul cere o dată `sudo chown` (parola sudo de pe server), mută `BACKUP_PATH=./backup_servers` pe calea absolută (cu copie `.env.bak-*`) și șterge fișierele vechi de cod. Scriptul refuză să ruleze dacă `BACKUP_PATH` ar fi în folderul de cod.

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
- **📜 Log-uri**: jurnalul fiecărei rulări de backup (manual sau programat), cu filtre (toate / eșuate / full / incrementale). Pentru erorile cunoscute se afișează ce s-a întâmplat și cum se repară (ex: rând prea mare, lipsă RELOAD pe un server cu GTID, privilegiu lipsă, server care nu răspunde). Din Dashboard-ul serverului, butonul „Vezi jurnalul și cauza” de lângă un backup eșuat deschide direct jurnalul lui. Jurnalele restaurărilor nu se păstrează încă;
- **⚙️ Setări**: numele serverului (redenumire), opțiunile mysqldump (vezi mai jos) și configurări proprii serverului (destinația backup-urilor, webhook Slack), care suprascriu setările globale din Opțiuni.

Lista de servere (sidebar și Dashboard) se actualizează imediat după adăugare, editare, ștergere sau import, fără refresh.

**Ultimele erori** (Dashboard-ul general, sub „Spațiu disc backup-uri”): backup-urile eșuate și upload-urile eșuate pe destinația remote din ultimele 7 zile, de la toate serverele (max. 2 per server, cele mai noi 10 în total), cu numele serverului, tipul (full / incremental), mesajul și când s-a întâmplat. O eroare e marcată „rezolvat” dacă după ea a urmat un backup reușit de același tip, cu upload reușit. Erorile nerezolvate apar și în cardul serverului lor. Click pe o eroare deschide jurnalul backup-ului, cu explicația cauzei.

### Restaurare de verificare (în altă bază)

În tab-ul **↩ Restore**, la „Destinație”, alegi „Altă bază de date, pe același server”. Backup-ul full se restaurează în baza indicată (implicit `<baza>_verificare`), iar baza originală nu se modifică. Așa poți verifica un backup sau vedea ce date erau la acel moment.

- Baza se creează automat dacă nu există. User-ul conexiunii are nevoie de drepturi pe ea: `GRANT ALL PRIVILEGES ON \`baza_verificare\`.* TO 'user'@'%';`.
- Dacă baza există și are tabele, restaurarea e refuzată, ca să nu suprascrii din greșeală altă bază. Bifează „Suprascrie baza existentă” pentru a o reface (ex: o verificare repetată).
- Nume permise: litere, cifre și `_`, maxim 64 de caractere. Bazele de sistem (`mysql`, `sys` etc.) sunt refuzate.
- Event-urile programate se dezactivează automat în copie, ca să nu ruleze singure pe server.
- Doar backup-urile **full**. Un incremental nu se poate restaura în altă bază: modificările din binlog conțin numele bazei originale și ar fi aplicate tot acolo.
- Restaurarea ocupă spațiu pe serverul MySQL și îl încarcă cât durează. După verificare, baza se șterge manual: `DROP DATABASE \`baza_verificare\`;`.
- Pe un server cu GTID, backup-ul trebuie făcut cu opțiunea „Fără GTID în backup”, altfel restaurarea dă eroarea 3546.

### Program și retenție (tab-ul 🕐 Program)

Frecvențe, alese din listă:

- **Full**: zilnic, luni–vineri, săptămânal (ziua + ora), lunar (ziua 1–28 + ora) sau o expresie cron personalizată;
- **Incremental**: la 1 / 2 / 4 / 6 / 12 ore, zilnic (la 24 de ore), săptămânal, lunar sau o expresie cron personalizată.

Pagina avertizează la combinații riscante:

- incremental fără full programat;
- incremental mai rar decât full-ul;
- incremental săptămânal sau lunar: serverul MySQL trebuie să păstreze binlog-urile cel puțin atât. „Testează drepturile și configurațiile” arată eroare dacă `binlog_expire_logs_seconds` e mai mic decât intervalul programat.

**Retenția (N zile) lucrează pe lanțuri.** Un incremental se restaurează doar peste full-ul de dinaintea lui și peste toate incrementalele dintre ele. Curățarea rulează după fiecare backup reușit (full sau incremental) și șterge doar ce a început înaintea *full-ului de bază*: cel mai nou full reușit, mai vechi de N zile. Rezultat:

- orice moment din ultimele N zile rămâne restaurabil;
- cel mai nou full nu se șterge niciodată, nici dacă full-urile eșuează o perioadă;
- cu full lunar și retenție 7 zile, pe disc rămân până la ~38 de zile (full-ul de bază și incrementalele lui).

**„Păstrează doar incrementalele de după ultimul full”**: după un full reușit, incrementalele dinaintea lui se șterg, fiindcă datele lor sunt deja în full. Momentele dintre full-urile mai vechi nu se mai pot restaura exact, doar full-urile.

Ce s-a șters se scrie în jurnalul backup-ului după care a rulat curățarea (tab-ul 📜 Log-uri).

Bulina din dreptul fiecărui server din sidebar arată starea după ultimul backup reușit (full sau incremental); legenda e sub listă:

- 🟡 galben: backup în curs;
- 🟢 verde: backup în ultimele 48h;
- 🟣 mov: niciun backup de peste 48h;
- 🔴 roșu: niciun backup de peste 7 zile sau niciodată.

### Destinația backup-urilor (local / SFTP / FTP / S3)

Backup-urile pot fi trimise, pe lângă disc, pe o destinație remote:

- **Local**: implicit, doar folderul `backup_servers/`.
- **SFTP / SSH**: autentificare cu parolă sau cheie privată (OpenSSH/PEM, opțional cu passphrase).
- **FTP / FTPS**: FTPS = TLS explicit, recomandat (FTP simplu trimite parola necriptat). Pentru servere cu certificat self-signed (ex: Synology cu certificatul implicit) bifează „Acceptă certificat self-signed”: conexiunea rămâne criptată, dar identitatea serverului nu mai e verificată, deci folosește-o doar în rețea internă. „Director remote” (SFTP și FTP) e obligatoriu și nu poate fi „/”. Subfolderele lipsă din el se creează automat. Pe Synology, primul nivel trebuie să fie un shared folder existent (ex: `/backup-databases-mysql` sau `/backup-databases-mysql/productie`): în rădăcina `/` nu se poate scrie și shared folder-ele nu se pot crea prin FTP.
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

Numele folderului per server e derivat din numele conexiunii: litere mici, diacritice românești convertite la litere de bază (ă/â→a, î→i, ș→s, ț→t), restul caracterelor non alfanumerice înlocuite cu `_`. Ex: „Server Producție #1” → `server_productie_1`.

Redenumirea unui server (tab-ul **⚙️ Setări** → „Nume server”):

- folderul local se redenumește automat, iar căile din istoricul backup-urilor se actualizează (restaurarea și descărcarea backup-urilor vechi merg în continuare);
- pe destinațiile remote (SFTP / FTP / S3), backup-urile vechi rămân în folderul vechi (calea e salvată per backup); cele noi merg în folderul cu numele nou;
- redenumirea e refuzată cât timp rulează un backup pentru acel server, sau dacă noul nume ar duce la un folder deja folosit de alt server / deja existent în `backup_servers/`.

## Baza de date internă

SQLite (`backend/data/app.db`) — conține conexiunile (inclusiv destinația proprie de backup a fiecărui server), istoricul backup-urilor (inclusiv unde e salvat fiecare fișier: local / SFTP / FTP / S3), programările (schedules) și setările platformei (ex. webhook-ul Slack, limita de alertă pentru spațiul pe disc, destinația implicită a backup-urilor). Fișierele de backup propriu-zise sunt în `backup_servers/` și/sau pe destinația remote.

## Cerințe pentru serverul MySQL backup-uit

- Binary logging activat (`log_bin = ON`, implicit în MySQL 8).
- User dedicat cu privilegii:
  - pe baza de date: `SELECT, SHOW VIEW, TRIGGER, EVENT`;
  - globale (`ON *.*`): `RELOAD, REPLICATION CLIENT, REPLICATION SLAVE` (pe MariaDB 10.5+, `BINLOG MONITOR` în loc de `REPLICATION CLIENT`).
- Backup-ul full are nevoie doar de privilegiile pe baza de date; pe servere cu GTID activ și de `RELOAD` (sau `FLUSH_TABLES`), dacă nu e activă opțiunea „Fără GTID în backup”. `RELOAD`, `REPLICATION CLIENT` și `REPLICATION SLAVE` sunt pentru backup-ul incremental.

```sql
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON `baza_de_date`.* TO `utilizator`@`%`;
GRANT RELOAD, REPLICATION CLIENT, REPLICATION SLAVE ON *.* TO `utilizator`@`%`;
```

### Testează drepturile și configurațiile

Din meniul ⋮ al serverului, din formularul de conexiune sau din tab-ul **📜 Log-uri**. Arată dacă backup-ul full și cel incremental pot rula și, pentru fiecare verificare, motivul și comanda de reparare:

- **Conexiune**: conectare (cu explicația erorii: parolă greșită, host nepermis, server care nu răspunde), versiune, existența bazei;
- **Privilegii**: verificate prin interogări inofensive unde se poate (`SELECT … LIMIT 0`, `SHOW CREATE VIEW`, `SHOW EVENTS`, `SHOW BINARY LOG STATUS`), altfel din `SHOW GRANTS`. Privilegiile primite prin roluri nu pot fi verificate; în acest caz lipsa apare ca avertisment, nu ca eroare;
- **Configurare server**: `log_bin`, formatul binlog (ROW recomandat), retenția binlog (inclusiv față de intervalul incrementalului din Program), GTID, `max_allowed_packet`, `net_write_timeout`, limite de durată a interogărilor, tabele non-InnoDB, mărimea bazei față de spațiul liber pentru backup-uri.

### Opțiuni mysqldump (per server)

Tab-ul **⚙️ Setări** → „Opțiuni mysqldump”. Implicit sunt dezactivate. Fiecare activare / dezactivare cere confirmare, cu motivul, ce face opțiunea și efectele ei:

- **Fără GTID în backup** (`--set-gtid-purged=OFF`): pentru servere cu GTID activ unde user-ul nu are `RELOAD` / `FLUSH_TABLES` (MySQL administrat: DigitalOcean, AWS RDS, Azure). Simptom: „Couldn't execute 'FLUSH TABLES': Access denied … RELOAD or FLUSH_TABLES”. Dump-ul nu mai conține `SET @@GLOBAL.GTID_PURGED`, deci restaurarea pe un server cu GTID nu mai dă eroarea 3546.
- **Rânduri mari** (`--max-allowed-packet=1G`, la backup și la restaurare): ridică limita clientului (24 MB mysqldump, 16 MB mysql). Necesară doar dacă jurnalul arată „Error 2020: Got packet bigger than max_allowed_packet”. Nu rezolvă „Error 2013: Lost connection … at row: N”: în teste pe MySQL 8.0.46 și 8.4, mysqldump citește rânduri de 30 MB indiferent de `max_allowed_packet` (client sau server). Nu schimbă nimic pe serverul MySQL.
- **Exclude tabele** (`--ignore-table`, doar la backup-ul full): listă de tabele, separate prin virgulă, ale căror rânduri nu intră în backup. Se salvează doar structura lor (`CREATE TABLE` și triggerele), deci la restaurare se creează goale. E o soluție temporară, de exemplu când serverul MySQL cade mereu la același rând dintr-un tabel (pagină coruptă), ca restul bazei să aibă backup până la reparare. Jurnalul fiecărui backup full și „Testează drepturile și configurațiile” arată tabelele excluse; un tabel inexistent oprește backup-ul („Couldn't find table”). Backup-urile incrementale conțin în continuare modificările din aceste tabele (mysqlbinlog filtrează doar pe bază), iar la restaurare un `UPDATE` / `DELETE` pe un rând care lipsește din full oprește aplicarea cu `ERROR 1032`. După reparare, golește lista și rulează un backup full.

`max_allowed_packet` al **serverului destinație** contează doar la restaurare: un rând mai mare dă `ERROR 1153` și limita se mărește pe server (`SET GLOBAL max_allowed_packet = 1073741824;` și `max_allowed_packet = 1G` în my.cnf, la `[mysqld]`).

**Error 2013 la backup** („Lost connection … when dumping table X at row: N”): după eroare, aplicația verifică automat cauza și o scrie în jurnal (liniile `DIAGNOSTIC:`): dacă serverul MySQL a repornit sau nu mai răspunde, dacă rândul la care s-a oprit dump-ul se poate citi separat (dacă nu, posibil tabel corupt), mărimea lui și a celui mai mare rând din tabel. Dacă serverul nu a repornit și rândul se citește normal, conexiunea a fost tăiată din afară: firewall / IPS / antivirus de rețea, `net_write_timeout` mic, rețea instabilă. Cauza exactă e în jurnalul de erori MySQL al serverului, la ora erorii (orele din jurnalul aplicației sunt UTC).

Dacă serverul MySQL **nu mai răspunde** după eroare („Can't connect … (111)”) și se întâmplă mereu la același rând, citirea acelui rând oprește serverul, aproape sigur din cauza unei pagini InnoDB corupte. În jurnalul de erori MySQL apar „Database page corruption” sau „Assertion failure”. Până la reparare, folosește opțiunea **Exclude tabele** pentru tabelul respectiv. Nu rula `CHECK TABLE` / `ALTER TABLE` pe el în producție fără o fereastră de mentenanță: când InnoDB găsește o pagină coruptă, oprește serverul intenționat.

Mereu active: `--single-transaction --no-tablespaces --column-statistics=0 --routines --triggers --events`. `--column-statistics=0` e necesar pentru MariaDB: fără el, mysqldump 8.0 se oprește după primul tabel.

Un backup full e marcat reușit doar dacă `mysqldump` se termină cu codul 0. Orice eroare MySQL în timpul dump-ului (ex: privilegiu lipsă, cod 2; conexiune pierdută la un tabel, cod 3) marchează backup-ul ca eșuat, fișierul incomplet se șterge și motivul apare în eroarea backup-ului, în tab-ul **📜 Log-uri** și în alerta Slack.

## Note de securitate

- Parolele MySQL și credențialele destinațiilor de backup (parole SFTP/FTP, chei SSH, chei S3) sunt stocate în SQLite, neencriptate — restricționează accesul la `data/app.db`. În UI, secretele salvate nu se mai afișează (apar mascate).
- Pentru destinațiile remote folosește un user dedicat, cu acces doar la directorul / bucket-ul de backup.
- Expune aplicația doar pe loopback sau în spatele unui reverse proxy autentificat (nginx, etc.).
