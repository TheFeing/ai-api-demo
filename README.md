# AI API Demo

A demonstration project for integrating and consuming AI model APIs (such as GitHub Models, Groq, or OpenAI). This project provides a clean boilerplate for making inference requests, managing environment variables for authentication, and handling streaming or non-streaming responses.

## Logic Overview
The core logic revolves around a centralized service handler that abstracts the API calls to various LLM providers.
* **Authentication:** Uses Personal Access Tokens (PAT) or API keys stored in environment variables.
* **Model Selection:** Configurable model endpoints (e.g., GPT-4o, Llama 3.1, Mistral) via a simple configuration file or constants.
* **Response Handling:** Support for standard JSON responses and real-time token streaming.

## Prerequisites
* **Node.js / Bun / Python:** (Update based on your specific language)
* **API Credentials:**
    * A GitHub Personal Access Token (with `models:read` permissions) for GitHub Models.
    * OR a specific provider API key (Groq, OpenAI, etc.).
* **Environment Configuration:** A `.env` file to store your secrets.

## Deployment Steps
1. **Clone the repository:**
   ```bash
   git clone [https://github.com/TheFeing/ai-api-demo.git](https://github.com/TheFeing/ai-api-demo.git)
   cd ai-api-demo
