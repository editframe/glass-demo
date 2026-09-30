import "@editframe/elements";
import "@editframe/elements/styles.css";
import { scenes } from "./scenes/index.js";

for (const el of document.querySelectorAll("ef-timegroup[data-scene]")) {
  const init = scenes[el.dataset.scene];
  if (init) el.initializer = init;
}
