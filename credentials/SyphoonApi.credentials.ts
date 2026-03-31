import {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class SyphoonApi implements ICredentialType {
  name = 'syphoonApi';
  displayName = 'Syphoon API';
  documentationUrl = 'https://docs.syphoon.com/authentication';
  icon = 'file:icon.svg' as const;

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      required: true,
      description:
        'Your Syphoon API key. Get yours at <a href="https://app.syphoon.com/api-keys" target="_blank">app.syphoon.com/api-keys</a>. New accounts include a free trial with 5,000 requests.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      body: {
        key: '={{$credentials.apiKey}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: 'https://api.syphoon.com',
      url: '/',
      method: 'POST',
      body: {
        url: 'https://example.com',
        key: '={{$credentials.apiKey}}',
        method: 'GET',
        render: false,
      },
    },
  };
}
