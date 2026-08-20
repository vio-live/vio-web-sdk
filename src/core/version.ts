/**
 * SDK version reported in analytics events (`sdk_version`) and available
 * to consumers. Kept as a constant (not a package.json import) so the
 * core stays bundler-agnostic.
 *
 * RELEASE CHECKLIST: bump together with package.json (see CONTRIBUTING).
 */
export const SDK_VERSION = '0.5.0'
