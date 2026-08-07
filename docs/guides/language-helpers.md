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
import urllib.request

request = urllib.request.Request(
    "https://app.keeperhub.com/api/keys",
    headers={
        "Authorization": "Bearer kh_your_api_key",
        "User-Agent": "my-agent/1.0",
    },
)

with urllib.request.urlopen(request) as response:
    print(response.status)
```

The `User-Agent` is an interoperability header, not an authentication credential
and not a permission. If a Python client receives a `403` while a known-good
client using the same credential succeeds, compare the actual request headers
before rotating keys or broadening permissions.

See [API Keys](/api/api-keys) for credential management and
[Authentication](/api/authentication) for the API authentication model.
