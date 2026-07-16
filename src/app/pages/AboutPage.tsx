export function AboutPage() {
  return (
    <div className="page narrow-page">
      <header className="page-header">
        <p className="eyebrow">About the project</p>
        <h1>About FluorCast</h1>
      </header>

      <section className="about-card">
        <span className="large-mark">F</span>
        <div>
          <h2>Two focused parts, one workflow</h2>
          <p>
            FluorCast Desktop is the local controller for preparing, submitting, and reviewing
            prediction jobs. It is intentionally separate from the scientific model repository.
          </p>
          <p>
            The existing ChemFluor/FluorCast repository on NIBI remains the prediction engine and
            owns the trained models, scientific dependencies, and inference code.
          </p>
        </div>
      </section>
    </div>
  );
}
