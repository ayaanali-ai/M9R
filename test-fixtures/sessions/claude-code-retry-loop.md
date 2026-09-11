## User

The build is failing, fix it.

## Assistant

Let me run the build.

⏺ Bash(npm run build)

```bash
$ npm run build
Error: build failed — TypeScript error in src/config.ts: Cannot find name 'env'
```

⏺ Read(src/config.ts)
⏺ Bash(npm run build)

```bash
$ npm run build
Error: build failed — TypeScript error in src/config.ts: Cannot find name 'env'
```

Let me try again.

⏺ Bash(npm run build)

```bash
$ npm run build
Error: build failed again — Cannot find name 'env'
```

⏺ Edit(src/config.ts)
⏺ Bash(npm run build)

```bash
$ npm run build
Build succeeded
```
