// Explică în română erorile cunoscute din jurnalul unui backup: ce s-a întâmplat și cum se repară.
// Regulile sunt în ordine, de la cele specifice la cele generale; se întoarce prima potrivire.

export interface Diagnosis {
  title: string;
  detail: string;
  fix?: string;
}

const GRANT_HINT = "Rulează pe serverul MySQL, ca root/admin";

const RULES: { test: RegExp; diagnose: (m: RegExpMatchArray) => Diagnosis }[] = [
  // Liniile „DIAGNOSTIC:” sunt scrise de backend după Error 2013 și au prioritate (cauza măsurată).
  {
    test: /DIAGNOSTIC: serverul MySQL (a repornit|nu mai răspunde)/,
    diagnose: m => ({
      title: m[1] === "a repornit" ? "Serverul MySQL a repornit în timpul backup-ului" : "Serverul MySQL a căzut în timpul backup-ului",
      detail:
        "Conexiunea s-a pierdut pentru că serverul MySQL s-a oprit (crash, lipsă memorie, restart). " +
        "Dacă se întâmplă mereu la același rând, citirea acelui rând oprește serverul (posibil tabel corupt).",
      fix:
        "1) Verifică jurnalul de erori MySQL pe server la ora erorii (ex: /var/log/mysql/error.log; ora din jurnalul aplicației e UTC): " +
        "„Database page corruption” / „Assertion failure” = tabel corupt; în dmesg „Out of memory” = lipsă memorie. " +
        "2) Până la reparare, exclude tabelul din backup: tab-ul Setări → „Exclude tabele”, ca restul bazei să aibă backup. " +
        "3) Nu rula CHECK TABLE / ALTER TABLE pe tabel în producție fără o fereastră de mentenanță: când InnoDB găsește " +
        "o pagină coruptă, oprește serverul.",
    }),
  },
  {
    test: /DIAGNOSTIC: citirea rândului \d+ eșuează și separat/,
    diagnose: () => ({
      title: "Rândul nu poate fi citit pe server (posibil tabel corupt)",
      detail: "Și o citire separată a rândului la care s-a oprit backup-ul eșuează, deci problema e pe serverul MySQL, nu în backup.",
      fix:
        "Verifică jurnalul de erori MySQL la ora erorii. Până la reparare, exclude tabelul din backup (tab-ul Setări → " +
        "„Exclude tabele”). CHECK TABLE / ALTER TABLE pe un tabel corupt pot opri serverul: rulează-le doar într-o fereastră de mentenanță.",
    }),
  },
  {
    test: /Error 2013: Lost connection to MySQL server during query when dumping table `([^`]+)` at row: (\d+)/,
    diagnose: m => ({
      title: `Conexiune pierdută la tabelul ${m[1]}, rândul ${m[2]}`,
      detail:
        "Conexiunea cu serverul MySQL a fost închisă în timpul citirii tabelului. Liniile „DIAGNOSTIC:” din jurnal arată " +
        "dacă serverul a repornit și dacă rândul se poate citi separat. Mărimea rândului nu e cauza (mysqldump citește " +
        "și rânduri de zeci de MB). Dacă eroarea apare mereu la același rând, iar serverul nu a repornit, conexiunea e tăiată " +
        "de obicei de un firewall / IPS / antivirus de rețea care inspectează conținutul (ex: un atașament). Dacă rândul diferă " +
        "de la o rulare la alta: net_write_timeout prea mic sau o rețea instabilă.",
      fix:
        "Caută ora erorii în jurnalul de erori MySQL al serverului („Aborted connection”) și în log-urile firewall-ului dintre " +
        "aplicație și server. Dacă rândul diferă la fiecare rulare: SET GLOBAL net_write_timeout = 600; pe serverul MySQL.",
    }),
  },
  {
    test: /ERROR 1153/,
    diagnose: () => ({
      title: "Rând mai mare decât limita serverului destinație",
      detail: "La restaurare, serverul MySQL refuză o instrucțiune mai mare decât max_allowed_packet al lui.",
      fix:
        `${GRANT_HINT} destinație: SET GLOBAL max_allowed_packet = 1073741824; ` +
        "și în my.cnf, la [mysqld]: max_allowed_packet = 1G. Nu necesită restart; rulează restaurarea din nou.",
    }),
  },
  {
    test: /Error 2020|bigger than 'max_allowed_packet'/i,
    diagnose: () => ({
      title: "Rând mai mare decât limita clientului",
      detail: "Un rând depășește max_allowed_packet al clientului mysqldump / mysql (24 MB / 16 MB implicit).",
      fix: "Tab-ul Setări → Opțiuni mysqldump → „Rânduri mari (--max-allowed-packet=1G)”.",
    }),
  },
  {
    test: /RELOAD or FLUSH_TABLES/,
    diagnose: () => ({
      title: "Lipsește RELOAD / FLUSH_TABLES pe un server cu GTID",
      detail:
        "Serverul are GTID activ, iar mysqldump execută FLUSH TABLES WITH READ LOCK, care cere RELOAD sau FLUSH_TABLES. " +
        "Pe MySQL administrat (DigitalOcean, AWS RDS, Azure) privilegiul nu se poate acorda.",
      fix:
        "Tab-ul Setări → Opțiuni mysqldump → „Fără GTID în backup (--set-gtid-purged=OFF)”, " +
        "sau GRANT RELOAD ON *.* TO user-ul de backup.",
    }),
  },
  {
    test: /COLUMN_STATISTICS/,
    diagnose: () => ({
      title: "Server MariaDB: dump oprit după primul tabel",
      detail:
        "mysqldump 8.0 cere statistici de coloană (tabelul COLUMN_STATISTICS), care nu există pe MariaDB. " +
        "Aplicația rulează acum mysqldump cu --column-statistics=0; backup-urile vechi cu această eroare sunt incomplete.",
      fix: "Rulează un backup full nou.",
    }),
  },
  {
    test: /ERROR 3546|GTID_PURGED cannot be changed/i,
    diagnose: () => ({
      title: "Restaurare pe un server cu GTID: GTID_PURGED nu poate fi schimbat",
      detail:
        "Backup-ul conține SET @@GLOBAL.GTID_PURGED, iar serverul destinație are deja GTID-uri executate.",
      fix:
        "Pentru backup-urile noi: tab-ul Setări → Opțiuni mysqldump → „Fără GTID în backup”. " +
        "Backup-ul existent se poate restaura pe un server fără GTID.",
    }),
  },
  {
    test: /Access denied for user .* \(using password/,
    diagnose: () => ({
      title: "Autentificare eșuată",
      detail: "User sau parolă greșite, ori user-ul nu are voie să se conecteze de pe IP-ul aplicației.",
      fix: "Verifică datele conexiunii și partea de host a user-ului ('user'@'%' sau IP-ul aplicației).",
    }),
  },
  {
    test: /Can't connect to MySQL server|Unknown MySQL server host|Nu se poate conecta la serverul MySQL/,
    diagnose: () => ({
      title: "Serverul MySQL nu răspunde",
      detail: "Host greșit, port închis, MySQL oprit sau firewall care blochează IP-ul aplicației.",
      fix: "Verifică host-ul, portul, bind-address în my.cnf și regulile de firewall.",
    }),
  },
  {
    test: /Couldn't execute 'show events'|Access denied for user .* to database .*events/i,
    diagnose: () => ({
      title: "Lipsește privilegiul EVENT",
      detail: "Backup-ul rulează cu --events, iar mysqldump se oprește dacă user-ul nu poate citi event-urile bazei.",
      fix: `${GRANT_HINT}: GRANT EVENT ON baza.* TO user;`,
    }),
  },
  {
    test: /SHOW VIEW command denied/i,
    diagnose: () => ({
      title: "Lipsește privilegiul SHOW VIEW",
      detail: "Baza are view-uri, iar mysqldump nu le poate citi definiția.",
      fix: `${GRANT_HINT}: GRANT SHOW VIEW ON baza.* TO user;`,
    }),
  },
  {
    test: /maximum statement execution time exceeded|max_statement_time exceeded|Query execution was interrupted/i,
    diagnose: () => ({
      title: "Interogare oprită de server (limită de durată)",
      detail: "Serverul are max_execution_time (MySQL) sau max_statement_time (MariaDB) setat, iar citirea unui tabel mare a durat mai mult.",
      fix: "SET GLOBAL max_execution_time = 0; (MySQL) sau SET GLOBAL max_statement_time = 0; (MariaDB)",
    }),
  },
  {
    test: /Unknown database/,
    diagnose: () => ({
      title: "Baza de date nu există",
      detail: "Numele bazei din conexiune nu există pe server sau user-ul nu are niciun drept pe ea.",
    }),
  },
  {
    test: /No space left on device|gzip: .*write error/i,
    diagnose: () => ({
      title: "Disc plin",
      detail: "Nu mai e spațiu pe discul folderului de backup (BACKUP_PATH).",
      fix: "Eliberează spațiu sau scade retenția (tab-ul Program).",
    }),
  },
  {
    test: /Nu există un backup full anterior/,
    diagnose: () => ({
      title: "Lipsește backup-ul full de referință",
      detail: "Incrementalul pornește de la poziția binlog salvată la ultimul backup full reușit.",
      fix: "Rulează un backup full (și verifică în acest tab de ce eșuează, dacă e cazul).",
    }),
  },
  {
    test: /nu mai există pe server \(probabil expirat\/purged\)/,
    diagnose: () => ({
      title: "Binlog-ul de referință a fost șters de pe server",
      detail: "Retenția binlog de pe serverul MySQL e mai scurtă decât intervalul dintre backup-uri.",
      fix: "Rulează un backup full; apoi mărește binlog_expire_logs_seconds sau fă backup-uri full mai des.",
    }),
  },
  {
    test: /Access denied; you need \(at least one of\) the ([A-Z_ ,]+) privilege/,
    diagnose: m => ({
      title: `Lipsește privilegiul ${m[1].trim()}`,
      detail: "User-ul de backup nu are un privilegiu administrativ necesar.",
      fix: `${GRANT_HINT}: GRANT ${m[1].split(",")[0].trim()} ON *.* TO user;`,
    }),
  },
  {
    test: /mysql-client nu este instalat|cod 127/,
    diagnose: () => ({
      title: "Uneltele MySQL lipsesc",
      detail: "mysqldump / mysqlbinlog nu sunt în PATH.",
      fix: "Rulează aplicația din containerul Docker.",
    }),
  },
];

export function diagnoseBackup(text: string): Diagnosis | null {
  for (const rule of RULES) {
    const m = text.match(rule.test);
    if (m) return rule.diagnose(m);
  }
  return null;
}
