// Vite's `?raw` import (vitest resolves it): the file's text as a string
declare module '*?raw' {
  const text: string;
  export default text;
}
