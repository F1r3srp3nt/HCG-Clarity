/** History: every output exported from this project, with what it was made from. */
import { formatBytes } from '../../clarity/sources';
import { OUTPUT_LABELS, useOutputs } from '../files';
import { useClarity } from '../state';

export function HistoryView() {
  const { clarity, updateClarity, dropBinary, store } = useClarity();
  const { redownload } = useOutputs();
  const name = {
    prompt: (id: string | null) => clarity.prompts.find((p) => p.id === id)?.title,
    dist: (id: string | null) => clarity.distillations.find((d) => d.id === id)?.title,
    source: (id: string) => clarity.sources.find((s) => s.id === id)?.name,
  };
  return (
    <section className="view" aria-labelledby="history-h">
      <header className="view-head">
        <div>
          <h1 id="history-h">History</h1>
          <p className="muted">Outputs exported from this project. A copy of each file is saved in the project, so you can download it again after reopening.</p>
        </div>
      </header>
      {clarity.outputs.length === 0 ? (
        <div className="empty card">
          <h2>No outputs yet</h2>
          <p className="muted">Exports from Distil, Refine and Create appear here.</p>
        </div>
      ) : (
        <table className="table" data-testid="history">
          <thead>
            <tr>
              <th>Output</th>
              <th>Made from</th>
              <th>Created</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {clarity.outputs.map((o) => {
              const from = [
                o.promptId && `Prompt: ${name.prompt(o.promptId) ?? '(deleted)'}${o.revisionId ? '' : ' (unsaved edit)'}`,
                o.distillationId && `Distillation: ${name.dist(o.distillationId) ?? '(deleted)'}`,
                o.sourceIds.length > 0 && `Sources: ${o.sourceIds.map((id) => name.source(id) ?? '(removed)').join(', ')}`,
              ].filter(Boolean);
              return (
                <tr key={o.id} data-testid="history-row">
                  <td>
                    <b>{o.fileName}</b>
                    <div className="muted small">
                      {OUTPUT_LABELS[o.kind]} · {formatBytes(o.bytes)}
                    </div>
                  </td>
                  <td className="small">{from.length ? from.map((f, i) => <div key={i}>{f}</div>) : <span className="muted">—</span>}</td>
                  <td className="small">{new Date(o.createdAt).toLocaleString()}</td>
                  <td className="nowrap">
                    <button className="btn small" onClick={() => void redownload(o)} disabled={!store.get(o.id)} data-testid="history-download">
                      Download again
                    </button>{' '}
                    <button
                      className="btn small ghost danger"
                      onClick={() => {
                        if (!confirm(`Remove "${o.fileName}" from History? Files you already saved are not affected.`)) return;
                        updateClarity((d) => void (d.outputs = d.outputs.filter((x) => x.id !== o.id)));
                        dropBinary(o.id);
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
