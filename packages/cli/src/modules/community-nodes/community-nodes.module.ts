import { Logger } from '@n8n/backend-common';
import type { BaseN8nModule } from '@n8n/decorators';
import { N8nModule } from '@n8n/decorators';

import { CommunityNodesPackagesService } from './community-nodes-packages.service';
import { CommunityNodesConfig } from './community-nodes.config';
import './community-nodes-packages.controller';
import './community-nodes-types.controller';

@N8nModule()
export class CommunityNodesModule implements BaseN8nModule {
	constructor(
		private readonly logger: Logger,
		private readonly config: CommunityNodesConfig,
		private readonly packagesService: CommunityNodesPackagesService,
	) {
		this.logger = this.logger.scoped('community-nodes');
	}

	async initialize() {
		if (this.config.enabled) {
			await this.packagesService.init();
		}
	}
}
