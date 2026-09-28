/**
 * Minimal protocol definition used by discover-plugins tests to exercise the
 * real dynamic import path (pathToFileURL), rather than an injected stub.
 * Never registered anywhere -- importing it must have no side effects.
 */
export default {
  slug: "protocol-fixture",
  name: "Protocol Fixture",
  description: "Fixture protocol definition for discover-plugins tests.",
  contracts: {},
  actions: [],
};
