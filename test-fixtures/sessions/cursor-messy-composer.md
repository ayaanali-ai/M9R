**You**

refactor the auth middleware, it's a mess

**Cursor**

Reading app/middleware/auth.ts

I'll refactor this.

Edited app/middleware/auth.ts

Let me run the tests:

```
$ npm test
FAIL app/middleware/auth.test.ts
  ● auth rejects missing token
    Expected 401, received 500
```

Editing app/middleware/auth.ts

```
$ npm test
FAIL app/middleware/auth.test.ts
  ● auth rejects missing token
    Expected 401, received 500
```

Editing app/middleware/auth.ts again

```
$ npm test
PASS app/middleware/auth.test.ts
```

Done.
