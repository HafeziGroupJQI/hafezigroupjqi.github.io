# Hafezi members gateway

This application authenticates lab members with GitHub, serves the private Quartz build, and links
the members site to the separate C2 instrument service. It has no instrument-control or experiment
data responsibilities.

From the website repository root:

```sh
cp members/.env.example members/.env
chmod 600 members/.env
PYENV_VERSION=3.12.13 python -m venv members/.venv
members/.venv/bin/pip install -e './members[dev]'
npm run build:internal
members/.venv/bin/hafezi-members
```

The members site defaults to `http://127.0.0.1:8100`; C2 remains at
`http://127.0.0.1:8000`. For GitHub login, create a separate OAuth App whose callback is
`http://127.0.0.1:8100/auth/callback`, then place its client ID and secret in `members/.env`.
