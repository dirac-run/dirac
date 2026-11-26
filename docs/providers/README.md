# Provider-Specific Settings

This document details the environment variables and configuration options for specific AI providers in Dirac.

## AWS Bedrock

Use Bedrock by setting AWS credentials and region. When `AWS_ACCESS_KEY_ID` or `AWS_BEDROCK_MODEL` is present, Dirac automatically switches to the Bedrock provider.

### Environment Variables

- `AWS_ACCESS_KEY_ID` — AWS access key
- `AWS_SECRET_ACCESS_KEY` — AWS secret key
- `AWS_SESSION_TOKEN` — session token (for temporary credentials)
- `AWS_REGION` — AWS region (e.g. `us-east-1`). Note: `AWS_REGION` alone will not trigger an automatic switch to Bedrock.
- `AWS_BEDROCK_MODEL` — model ID for both act and plan modes (e.g. `us.anthropic.claude-sonnet-4-6`)
- `AWS_BEDROCK_MODEL_ACT` — model ID for act mode only
- `AWS_BEDROCK_MODEL_PLAN` — model ID for plan mode only

### Usage Example

Works seamlessly with [aws-vault](https://github.com/99designs/aws-vault):

```bash
AWS_REGION=us-east-1 AWS_BEDROCK_MODEL=us.anthropic.claude-sonnet-4-6 \
  aws-vault exec my-profile -- dirac "your task"
```

> **Note:** Newer Claude models on Bedrock (Sonnet 4.6+) require a cross-region inference profile prefix (`us.`, `eu.`, `ap.`). See the [AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html) for supported model IDs.

## Google Cloud Vertex AI

Use Vertex AI by setting the following environment variables. When `GOOGLE_CLOUD_PROJECT` or `GCP_PROJECT` is present, Dirac automatically switches to the Vertex provider.

### Environment Variables

- `GOOGLE_CLOUD_PROJECT` or `GCP_PROJECT` — Your Google Cloud project ID.
- `GOOGLE_CLOUD_LOCATION` or `GOOGLE_CLOUD_REGION` — The region for Vertex AI (e.g. `us-central1`).

### Authentication

Dirac uses the default Google Cloud authentication chain. Ensure you have authenticated using the Google Cloud CLI:

```bash
gcloud auth application-default login
```

## Qwen Code Plus / Pro

The **Qwen Code** provider uses subscription credentials cached by the
[official Qwen Code CLI](https://github.com/QwenLM/qwen-code). It is separate from
Dirac's **Qwen** provider, which uses a DashScope API key.

1. Install and launch the official CLI (`qwen`).
2. Run `/auth` and choose Qwen Code subscription sign-in with your Plus or Pro account.
3. After sign-in creates `subscription_credentials.json`, select **Qwen Code** in
   Dirac's API Providers settings. In the Dirac CLI, select Qwen Code during provider
   setup; it asks for an optional credential file path, not an API key.

Both the VS Code extension and Dirac CLI resolve the file in this order:

1. The optional **Subscription Credentials Path** (`qwenCodeOauthPath`), used as a file path.
2. `QWEN_HOME/subscription_credentials.json`, when `QWEN_HOME` is set.
3. `~/.qwen/subscription_credentials.json` otherwise.

Home-relative paths (`~/...`) work for both the custom path and `QWEN_HOME`.
`QWEN_HOME` must be available to the process running Dirac (the extension host for
VS Code); setting it only in an unrelated terminal does not change that process.
A custom path overrides `QWEN_HOME`. Leave it blank to restore automatic lookup.

Provider availability uses saved setup or local file presence; it does not prove
that credentials are valid, that your subscription is active, or that a model is
available to your account. Setup and automated tests do not perform a live sign-in
or verify subscription entitlement. Use the official CLI's `/auth` again if your
subscription credentials need to be renewed. Do not paste credential file contents
into Dirac settings or an API-key field.

Inference requests identify Dirac as the client; Dirac does not impersonate the
official Qwen Code CLI. If Qwen's gateway rejects third-party clients or your
subscription does not permit this use, use the official client or Dirac's API-key
**Qwen** / **OpenAI Compatible** provider with an authorized endpoint instead.
Renaming or copying a credential file does not change gateway policy or account
entitlement.
