import type { MessageOrigin } from '@automator/shared';

export type { Logger } from '../contracts.js';

export interface MessageOriginRef {
  origin: MessageOrigin;
  originRef?: string;
}
