# Security

## Data model

Trajecta writes explicit work metadata to a local directory. It does not
inspect prompts, hidden reasoning, browser tabs, credentials, environment
variables, or arbitrary workspace files.

Do not put secrets, access tokens, private prompts, personal history, or raw
tool output into delta summaries or provenance labels. Keep the Trajecta state
directory out of version control; `.trajecta/` is ignored by default.

## Reports

Please report security issues privately to the repository owner rather than
opening a public issue with exploit details. Include the affected version,
reproduction steps, and the smallest safe proof.

## Non-guarantees

A transfer packet is not authentication, authorization, encryption, delivery
proof, or outcome verification. Deployments that cross a machine or trust
boundary must provide those controls in their adapter.
