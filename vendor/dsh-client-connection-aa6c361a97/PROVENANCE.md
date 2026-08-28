# Vendored DSH connection source

This directory contains the `packages/client/connection/src` tree from
DeepSeek Harness commit `aa6c361a97` (`release(dsh): 0.1.1-rc.2`).

The upstream `dsh-login` source imports private connection modules that are not
included in the published `@deepseek-ai/dsh-client-connection` package. The
compatibility build bundles this exact source into `dist/index.js` and
`dist/connection.js`. The upstream MIT license is preserved as `LICENSE`.
