import { render } from "solid-js/web";
import { App } from "./App";
import { registerServiceWorker } from "./state/offline";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

render(() => <App />, root);

// After the app, never before it. The worker's install fetches the shell, and
// racing that against the client's first request for mail costs the reader the
// thing they opened the app for.
registerServiceWorker();
