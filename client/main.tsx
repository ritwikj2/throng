import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="desktop boot-desktop">
          <section className="boot-window">
            <div className="window-title">
              <h1>THRONG — Display error</h1>
            </div>
            <div className="boot-content">
              <p>The display stopped responding.</p>
              <p className="small-print">
                Reload to reconnect to the saved world. This does not create or delete a world.
              </p>
              <button className="default-button" onClick={() => location.reload()}>
                Reload display
              </button>
            </div>
          </section>
        </main>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>,
);
