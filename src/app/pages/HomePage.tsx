const capabilities = [
  { symbol: "λₐ", title: "Absorption", detail: "Predicted maximum absorption wavelength" },
  { symbol: "λₑ", title: "Emission", detail: "Predicted maximum emission wavelength" },
  { symbol: "Φ", title: "Quantum yield", detail: "Predicted fluorescence efficiency" },
];

export function HomePage() {
  return (
    <div className="page home-page">
      <section className="home-hero">
        <p className="eyebrow">Molecular fluorescence prediction</p>
        <h1>From structure to signal.</h1>
        <p className="lede">
          FluorCast predicts absorption wavelength, emission wavelength, and quantum yield
          for molecule–solvent pairs.
        </p>
      </section>

      <section className="capability-grid" aria-label="Prediction capabilities">
        {capabilities.map((capability) => (
          <article className="capability-card" key={capability.title}>
            <span className="science-symbol">{capability.symbol}</span>
            <div><h2>{capability.title}</h2><p>{capability.detail}</p></div>
          </article>
        ))}
      </section>

      <section className="info-panel">
        <div><span className="step-label">How it works</span><h2>Desktop here. Compute there.</h2></div>
        <p>
          Prepare jobs in this app and submit them to NIBI for computation. FluorCast handles
          the workflow, so users never need to work from the command line.
        </p>
      </section>
    </div>
  );
}
