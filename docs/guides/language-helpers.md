---
title: "Language-specific Helpers"
description: "Optional client-library-specific interoperability patterns for KeeperHub integrations."
---

# Language-specific Helpers

KeeperHub's REST API is language-agnostic. This page collects optional patterns
for client libraries whose defaults can differ across runtimes. These examples
do not change KeeperHub authentication or permission requirements.

## Python

### `urllib` authentication probe

For Python `urllib` clients, use the same `GET /api/keys` authentication probe
as other clients and send the organization API key in the `Authorization`
header. An explicit, stable application `User-Agent` avoids depending on the
library-generated default request signature:

```python
import urllib.error
import urllib.request

request = urllib.request.Request(
    "https://app.keeperhub.com/api/keys",
    headers={
        "Authorization": "Bearer kh_your_api_key",
        "User-Agent": "my-agent/1.0",
    },
)

try:
    with urllib.request.urlopen(request) as response:
        print(response.status)
except urllib.error.HTTPError as error:
    print(error.code)
```

The `User-Agent` is an interoperability header, not an authentication credential and not a permission. When probing `GET /api/keys` (documented to return `200` on success or `401` for invalid credentials), if a Python client receives an unexpected response status while a known-good client using the same credential succeeds, compare the actual request construction and headers before rotating keys or broadening permissions.

See [API Keys](/api/api-keys) for credential management and
[Authentication](/api/authentication) for the API authentication model.
