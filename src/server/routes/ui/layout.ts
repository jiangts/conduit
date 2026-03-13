function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderOperatorHeader(input: {
  current: "playground" | "status";
  title: string;
  description: string;
  trailing?: string;
}): string {
  return `
    <div class="topbar">
      <div class="stack">
        <h1>${escapeHtml(input.title)}</h1>
        <p class="lead">${escapeHtml(input.description)}</p>
      </div>
      <div class="stack topbar-side">
        <nav class="operator-nav" aria-label="Operator navigation">
          <a class="operator-link${input.current === "playground" ? " active" : ""}" href="/playground">Playground</a>
          <a class="operator-link${input.current === "status" ? " active" : ""}" href="/status">Status</a>
        </nav>
        ${input.trailing ?? ""}
      </div>
    </div>
  `;
}

export function renderOperatorShellStyles(): string {
  return `
    :root { color-scheme: light; --bg: #f4efe6; --panel: #fffdf9; --ink: #1f2937; --muted: #6b7280; --line: #d6d3d1; --accent: #0f766e; --warn: #b45309; --danger: #b91c1c; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: radial-gradient(circle at top left, #fff8eb, #f1ece2 55%, #e8e0d2); color: var(--ink); }
    main { max-width: 1200px; margin: 0 auto; padding: 24px; }
    h1, h2, h3 { margin: 0; font-weight: 600; }
    h1 { font-size: 2rem; }
    p { margin: 0; }
    a { color: #115e59; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .lead, .muted, small { color: var(--muted); }
    .topbar, .stack, .actions, .result-stack, .section-head, .attempt-head, .stat-row, .filters, .links { display: flex; gap: 16px; }
    .topbar { align-items: flex-start; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; }
    .stack, .result-stack { flex-direction: column; }
    .topbar-side { align-items: flex-end; }
    .operator-nav { display: inline-flex; gap: 8px; padding: 6px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.75); }
    .operator-link { display: inline-flex; align-items: center; padding: 8px 14px; border-radius: 999px; color: var(--ink); }
    .operator-link:hover { text-decoration: none; background: rgba(19,78,74,0.08); }
    .operator-link.active { background: #134e4a; color: white; }
    .card { background: rgba(255, 253, 249, 0.92); border: 1px solid var(--line); border-radius: 16px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
    .pill { display: inline-flex; align-items: center; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.7); }
    @media (max-width: 720px) { main { padding: 16px; } .topbar-side { align-items: flex-start; } .section-head, .attempt-head, .stat-row, .filters, .links { justify-content: flex-start; } }
  `;
}
