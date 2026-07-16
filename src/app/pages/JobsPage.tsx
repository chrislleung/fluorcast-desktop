import type { StoredPredictionJob } from "../../features/jobs";

type JobsPageProps = {
  jobs: StoredPredictionJob[];
  onOpenResult: (jobId: string) => void;
};

const statusLabels: Record<StoredPredictionJob["status"], string> = {
  queued_locally: "Queued locally",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

function formatCreatedDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function JobsPage({ jobs, onOpenResult }: JobsPageProps) {
  return (
    <div className="page narrow-page">
      <header className="page-header">
        <p className="eyebrow">Job history</p>
        <h1>Jobs</h1>
        <p>Monitor submitted predictions and open completed results.</p>
      </header>

      {jobs.length === 0 ? (
        <section className="empty-state">
          <span className="empty-icon" aria-hidden="true">...</span>
          <h2>No prediction jobs yet</h2>
          <p>Your submitted and completed local mock jobs will appear here.</p>
        </section>
      ) : (
        <section className="result-section" aria-label="Prediction job history">
          <div className="section-heading">
            <h2>Local jobs</h2>
            <span>{jobs.length}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Molecule SMILES</th>
                  <th>Solvent SMILES</th>
                  <th>Model choice</th>
                  <th>Status</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{formatCreatedDate(job.created_at)}</td>
                    <td><code>{job.molecule_smiles}</code></td>
                    <td><code>{job.solvent_smiles}</code></td>
                    <td>{job.model_choice}</td>
                    <td>
                      <span className={`job-status job-status-${job.status}`}>
                        {statusLabels[job.status]}
                      </span>
                    </td>
                    <td>
                      {job.status === "completed" ? (
                        <button
                          className="secondary-button compact-button"
                          onClick={() => onOpenResult(job.id)}
                          type="button"
                        >
                          Open result
                        </button>
                      ) : job.status === "failed" ? (
                        <span>{job.error_message ?? "Failed"}</span>
                      ) : (
                        <span>Loading</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
