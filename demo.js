export const initialDemoState = "ready";

const transitions = {
  ready: { TRY_STALE: "rejected", USE_VERIFIED: "verified", REPLAY: "ready" },
  rejected: { TRY_STALE: "rejected", USE_VERIFIED: "verified", REPLAY: "ready" },
  verified: { RESUME: "resumed", TRY_STALE: "rejected", REPLAY: "ready" },
  resumed: { TRY_STALE: "rejected", USE_VERIFIED: "verified", REPLAY: "ready" },
};

const views = {
  ready: { tone: "neutral", title: "Choose a bounded packet", message: "The selected packet is stale. Try it to see the revision guard work.", expectedRevision: "12", currentRevision: "14", branch: "launch-proof", verification: "candidate · not accepted", nextAction: "Try stale handoff" },
  rejected: { tone: "rejected", title: "Stale handoff rejected", message: "Revision 12 cannot resume work that is already at revision 14. Nothing was overwritten.", expectedRevision: "12", currentRevision: "14", branch: "launch-proof", verification: "rejected · revision mismatch", nextAction: "Use verified packet" },
  verified: { tone: "verified", title: "Verified packet selected", message: "The current packet carries the exact branch, evidence, open loops, and next action.", expectedRevision: "14", currentRevision: "14", branch: "launch-proof", verification: "verified · provenance intact", nextAction: "Resume local agent" },
  resumed: { tone: "resumed", title: "Local work resumed", message: "Revision 15 is accepted on the exact branch. The next action is ready for the local build.", expectedRevision: "14", currentRevision: "15", branch: "launch-proof", verification: "accepted · CAS resume", nextAction: "Review the receipt" },
};

export function reduceDemo(state, event) { return transitions[state]?.[event] ?? state; }
export function describeDemo(state) { return { ...views[state] ?? views.ready }; }

if (typeof document !== "undefined") {
  const root = document.querySelector("[data-demo-root]");
  if (root) {
    let state = initialDemoState;
    const render = () => {
      const view = describeDemo(state);
      root.dataset.state = state;
      for (const element of root.querySelectorAll("[data-field]")) element.textContent = view[element.dataset.field] ?? "";
      for (const button of root.querySelectorAll("[data-action]")) {
        const event = button.dataset.action;
        const next = reduceDemo(state, event);
        button.disabled = next === state && event !== "REPLAY";
      }
      const live = root.querySelector("[aria-live]");
      if (live) live.textContent = view.message;
    };
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button || button.disabled) return;
      state = reduceDemo(state, button.dataset.action);
      render();
    });
    render();
  }
}
