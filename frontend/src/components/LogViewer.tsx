import { useEffect, useRef } from 'react';

interface Props {
  lines: string[];
  running?: boolean;
  title?: string;
}

function lineClass(line: string): string {
  const l = line.toLowerCase();
  if (l.includes('eroare') || l.includes('error') || l.includes('err ') || l.includes('failed')) return 'log-error';
  if (l.includes('warn')) return 'log-warn';
  if (l.includes('finalizat') || l.includes('succes') || l.includes('complet')) return 'log-ok';
  if (l.includes('conectare') || l.includes('pornire') || l.includes('rulare') || l.includes('procesez')) return 'log-info';
  return 'log-default';
}

export default function LogViewer({ lines, running = false, title = 'Jurnal execuție' }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  if (lines.length === 0 && !running) return null;

  return (
    <div className="log-viewer">
      <div className="log-header">
        <span className="log-title">{title}</span>
        {running && (
          <span className="log-running">
            <span className="spinner" style={{ width: 12, height: 12 }} /> rulează...
          </span>
        )}
        <span className="log-count">{lines.length} linii</span>
      </div>
      <div className="log-body">
        {lines.length === 0 && running && (
          <div className="log-line log-default">Se inițializează...</div>
        )}
        {lines.map((line, i) => (
          <div key={i} className={`log-line ${lineClass(line)}`}>
            {line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
