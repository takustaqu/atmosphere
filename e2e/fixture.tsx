// What the tests call from inside the page: the library, and the React sample
// mounted on a root they can render into again
import { createRoot, type Root } from 'react-dom/client';
import { Atmosphere } from '../src/index.js';
import { AtmosphereCanvas, type AtmosphereCanvasProps } from '../examples/react/index.js';

const roots = new Map<string, Root>();

Object.assign(window, {
  Atmosphere,
  renderSky(id: string, props: AtmosphereCanvasProps) {
    let root = roots.get(id);
    if (!root) {
      root = createRoot(document.getElementById(id)!);
      roots.set(id, root);
    }
    root.render(<AtmosphereCanvas {...props} />);
  },
});
