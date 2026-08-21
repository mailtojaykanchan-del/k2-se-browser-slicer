# Bundled Kiri:Moto Engine

- Version: `4.7.2`
- Project: `GridSpace/grid-apps`
- Engine source: `https://grid.space/lib/kiri/run/engine.js`
- Worker source: `https://grid.space/lib/kiri/run/worker.js`
- WebAssembly source: `https://grid.space/wasm/manifold.wasm`
- Retrieved: `2026-08-12`

The engine is distributed under the MIT license in `LICENSE.md`.

Local static-host patches keep worker and WebAssembly URLs relative to these bundled assets and skip the engine's unused worker-pool startup.
