#!/usr/bin/env python3
"""Render networkpolicy.yaml the way install.sh does, then check the result.

TEST SCAFFOLDING, not part of the product. It touches no cluster and needs no
cluster, so CI can run it and so can you:

    ./test-harness/check-policy-render.py

Why this exists. Every other file in this directory is either a values file,
which the Self-hosted Profile Render job already renders, or a script, which
shellcheck already reads. networkpolicy.yaml is neither. It is substituted with
envsubst at install time, and two of the three values it takes are multi-line
YAML lists rather than single words.

That combination fails in a way review does not catch. envsubst does not know a
comment from a value, so naming a list variable inside a comment expands the
list there, breaks out of the comment, and produces a file that still reads like
YAML in a diff and is rejected by the API server. That happened once while this
check was being written, which is why the check exists.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit(
        "This check needs PyYAML.\n"
        "    pip install pyyaml   (GitHub's ubuntu runners already have it)"
    )

HERE = Path(__file__).resolve().parent
PROFILE = HERE.parent
POLICY = PROFILE / "networkpolicy.yaml"
INSTALL = PROFILE / "install.sh"

# Synthetic. The point is that the file renders, not that any address is real.
# Two of each, because one entry cannot show a list rendering as a list.
NAMESPACE = "keeperhub"
CIDRS = ["10.43.0.1/32", "10.0.0.5/32"]
PORTS = [443, 6443]

# The indentation install.sh bakes into each fragment. It belongs to the
# fragment rather than to the template, because a substituted value carries its
# own leading whitespace and the template cannot add any.
#
# This is a second copy of what install.sh writes, so assert_matches_install
# below fails when the two drift. Same reason config.sh has assert_overlay: a
# constant written down twice is a constant that will disagree with itself.
CIDR_INDENT = " " * 8
CIDR_FIELD_INDENT = " " * 12
PORT_INDENT = " " * 8
PORT_FIELD_INDENT = " " * 10

# The five documents the file is meant to produce. Named rather than counted, so
# that a lost document is reported as the one it lost.
EXPECTED_POLICIES = {
    "keeperhub-default-deny-egress",
    "keeperhub-allow-dns",
    "keeperhub-allow-in-namespace",
    "keeperhub-allow-apiserver",
    "keeperhub-allow-public-egress",
}

APISERVER_POLICY = "keeperhub-allow-apiserver"


# An `envsubst '<names>'` whose command goes on to read networkpolicy.yaml,
# across up to two backslash-continued lines. Anchored on the filename because
# install.sh substitutes sandbox.yaml as well, with a different variable list.
ENVSUBST_CALL = re.compile(
    r"envsubst '((?:\$\{[A-Z_]+\} ?)+)'"
    r"(?:[^\n]*\\\n){0,2}[^\n]*networkpolicy\.yaml"
)


def envsubst_names() -> list[str]:
    """The variable names install.sh passes to envsubst for networkpolicy.yaml.

    Read out of install.sh rather than repeated here. envsubst given a list
    substitutes those names and leaves every other one alone, so this check
    renders what an install renders rather than something close to it.

    install.sh has two of these calls, one for --dry-run and one for the apply.
    They have to agree, so disagreement is reported here rather than left to
    produce a dry run that shows something the install would not do.
    """
    lists = ENVSUBST_CALL.findall(INSTALL.read_text())
    if not lists:
        sys.exit(
            f"No envsubst call for {POLICY.name} found in {INSTALL.name}.\n"
            "This check renders the policy the way install.sh does, so it cannot\n"
            "run without knowing which variables install.sh substitutes."
        )
    names = [re.findall(r"\$\{([A-Z_]+)\}", found) for found in lists]
    if any(entry != names[0] for entry in names):
        sys.exit(
            f"{INSTALL.name} substitutes a different variable list per call site:\n"
            + "\n".join(f"    {entry}" for entry in names)
        )
    return names[0]


def assert_matches_install() -> None:
    """Fail when install.sh no longer builds the fragments this check assumes.

    Structural on purpose. A search for the bare number of spaces would be
    satisfied by any line that happened to have them, so each pattern matches
    the literal install.sh writes, quotes and all.
    """
    text = INSTALL.read_text()
    literals = {
        "the ipBlock item": f'"{CIDR_INDENT}- ipBlock:"',
        "the cidr field": f'"{CIDR_FIELD_INDENT}cidr: ',
        "the protocol item": f'"{PORT_INDENT}- protocol: TCP"',
        "the port field": f'"{PORT_FIELD_INDENT}port: ',
    }
    drifted = [what for what, literal in literals.items() if literal not in text]
    if drifted:
        sys.exit(
            f"{INSTALL.name} no longer indents {', '.join(drifted)} the way this\n"
            "check does. The indentation belongs to the fragment rather than to\n"
            "the template, so a change on one side renders YAML the other side\n"
            f"does not expect. Update {Path(__file__).name} and {INSTALL.name} together."
        )


def cidr_fragment(cidrs: list[str]) -> str:
    return "\n".join(
        f"{CIDR_INDENT}- ipBlock:\n{CIDR_FIELD_INDENT}cidr: {cidr}" for cidr in cidrs
    )


def port_fragment(ports: list[int]) -> str:
    return "\n".join(
        f"{PORT_INDENT}- protocol: TCP\n{PORT_FIELD_INDENT}port: {port}"
        for port in ports
    )


def render(names: list[str]) -> str:
    """Run the real envsubst, so this checks what install.sh produces."""
    values = {
        "NAMESPACE": NAMESPACE,
        "APISERVER_CIDRS": cidr_fragment(CIDRS),
        "APISERVER_PORTS": port_fragment(PORTS),
    }
    missing = [name for name in names if name not in values]
    if missing:
        sys.exit(
            f"install.sh substitutes {', '.join(missing)} and this check has no "
            f"value for it.\nAdd one to `values` in {Path(__file__).name}."
        )

    # Resolved before the call, because the env below carries no PATH for the
    # child to search.
    envsubst = shutil.which("envsubst")
    if not envsubst:
        sys.exit("envsubst is not installed. It ships with gettext.")

    result = subprocess.run(
        [envsubst, " ".join(f"${{{name}}}" for name in names)],
        input=POLICY.read_text(),
        # Only these, rather than the ambient environment. A variable that
        # happens to be set on the machine running this would otherwise render
        # a file no install produces.
        env={name: values[name] for name in names},
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def fail(message: str) -> None:
    """One error, annotated for GitHub when it is GitHub reading it."""
    prefix = "::error::" if os.environ.get("GITHUB_ACTIONS") else "  - "
    print(f"{prefix}{message}")


def check(rendered: str) -> list[str]:
    """Every way the render can be wrong, reported together rather than one per run."""
    errors: list[str] = []

    leftover = sorted(set(re.findall(r"\$\{[A-Z_]+\}", rendered)))
    if leftover:
        errors.append(f"left an envsubst placeholder: {', '.join(leftover)}")

    try:
        docs = [doc for doc in yaml.safe_load_all(rendered) if doc]
    except yaml.YAMLError as exc:
        # The failure a fragment expanded in the wrong place produces. Worth its
        # own branch, because every check below needs a parsed file.
        errors.append(f"did not parse as YAML: {exc}")
        return errors

    kinds = {doc.get("kind") for doc in docs}
    if kinds != {"NetworkPolicy"}:
        errors.append(f"rendered {sorted(map(str, kinds))}, expected only NetworkPolicy")
        return errors

    by_name = {doc["metadata"]["name"]: doc for doc in docs}
    if set(by_name) != EXPECTED_POLICIES:
        lost = EXPECTED_POLICIES - set(by_name)
        extra = set(by_name) - EXPECTED_POLICIES
        if lost:
            errors.append(f"did not render {', '.join(sorted(lost))}")
        if extra:
            errors.append(f"rendered an unexpected policy: {', '.join(sorted(extra))}")

    for name, doc in by_name.items():
        if doc["metadata"].get("namespace") != NAMESPACE:
            errors.append(f"{name} is in namespace {doc['metadata'].get('namespace')!r}")

    # The API server rule specifically, because it is the one that takes the
    # multi-line lists and the one that fails silently when it is wrong: a rule
    # that names the wrong address applies cleanly and blocks the executor.
    apiserver = by_name.get(APISERVER_POLICY)
    if apiserver:
        rule = apiserver["spec"]["egress"][0]
        # An empty `to` allows every destination and an empty `ports` allows
        # every port, so a fragment that rendered as nothing turns the tightest
        # rule in the file into the loosest one. It has to read as an error
        # here rather than as an empty list to compare.
        if not rule.get("to") or not rule.get("ports"):
            errors.append(
                f"{APISERVER_POLICY} rendered to={rule.get('to')} ports={rule.get('ports')}; "
                "an empty list there allows everything"
            )
        else:
            got_cidrs = [entry["ipBlock"]["cidr"] for entry in rule["to"]]
            got_ports = [entry["port"] for entry in rule["ports"]]
            if got_cidrs != CIDRS:
                errors.append(f"{APISERVER_POLICY} allows {got_cidrs}, expected {CIDRS}")
            if got_ports != PORTS:
                errors.append(f"{APISERVER_POLICY} allows {got_ports}, expected {PORTS}")

    return errors


def main() -> int:
    assert_matches_install()
    rendered = render(envsubst_names())
    errors = check(rendered)
    if errors:
        print(f"{POLICY.name} rendered wrongly:")
        for error in errors:
            fail(error)
        return 1
    print(f"ok: {POLICY.name} renders {len(EXPECTED_POLICIES)} NetworkPolicy documents")
    return 0


if __name__ == "__main__":
    sys.exit(main())
