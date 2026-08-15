import { MockThetaV3Transport } from '../../../mocks/v3/scenario-router';
import { ThetaAgentV3Client } from './client';
import { HttpTransport, type ThetaV3Transport } from './transport';

export type ThetaV3TransportMode = 'mock' | 'local-backend';

export const configuredTransportMode = (): ThetaV3TransportMode =>
  process.env.NEXT_PUBLIC_THETA_AGENT_V3_TRANSPORT === 'local-backend'
    ? 'local-backend'
    : 'mock';

export const createThetaAgentV3Client = (
  mode: ThetaV3TransportMode = configuredTransportMode(),
): ThetaAgentV3Client => new ThetaAgentV3Client(createTransport(mode));

const createTransport = (mode: ThetaV3TransportMode): ThetaV3Transport =>
  mode === 'mock' ? new MockThetaV3Transport() : new HttpTransport();
