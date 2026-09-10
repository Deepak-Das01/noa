# Project instructions

- Preserve existing user data and app behavior unless the requested task changes them.
- Every change to this application MUST include an update to README.md in the same task. Record UI, behavior, feature, fix, dependency, configuration, packaging, and documentation changes under the Unreleased changelog section, with relevant validation and restart/migration notes.
- Also update affected README usage instructions and limitations. Keep historical release entries intact.
- The documented baseline is 0.1.0. Keep README and package.json release versions synchronized. Bump versions when preparing a release, not automatically for every edit.
- Before delivering a distribution, regenerate the clean ZIP, including README.md and this AGENTS.md. Exclude data, node_modules, logs, and private files.
