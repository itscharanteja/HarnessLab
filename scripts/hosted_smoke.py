"""Run the public, zero-spend fixture through an authorized hosted web origin."""

import os
from urllib.parse import urlsplit

from scripts.demo_fixture import main

if __name__ == "__main__":
    base = os.environ.get("BASE_URL", "")
    url = urlsplit(base)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.hostname != url.netloc
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
    ):
        raise SystemExit("Set BASE_URL to the approved hosted HTTPS site origin")
    os.environ["HL_WEB_BASE_URL"] = base.rstrip("/")
    main()
