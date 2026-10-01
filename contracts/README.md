# agate contracts

Foundry project for the wall (`AgateIndex`). Build spec: `../docs/wall/BUILD-SPEC.md`.

```
forge install --no-git foundry-rs/forge-std@v1.17.0                # lib/ is not committed
forge build --sizes
forge test
forge test --match-path 'test/gas/*' --gas-report --isolate   # the call shapes of BUILD-SPEC 4.14
anvil --code-size-limit 131072                                  # Monad allows 128 KB of runtime code
AGATE_CONFIG=local-demo forge script script/DeployIndex.s.sol --rpc-url anvil --broadcast \
  --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

`AgateIndex` keeps its storage and the cheap views; the logic runs in four linked libraries
(`IndexReports`, `IndexDays`, `IndexViews`, `IndexAdmin`) by DELEGATECALL, so every contract stays under 24 KB.
`forge test` and `forge script` deploy and link them automatically.

Differential vectors (`test/vectors/diff_*.json`, numbers only) come from the reference model, which stays outside
the repo: `AGATE_REFERENCE_MODEL=/path/to/reference_model.py python3 test/vectors/gen_vectors.py`.
