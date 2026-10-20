CREATE TABLE `oauth_state_nonces` (
	`nonce` varchar(64) NOT NULL,
	`platform` enum('web','native') NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `oauth_state_nonces_nonce` PRIMARY KEY(`nonce`)
);
--> statement-breakpoint
CREATE TABLE `official_mosques` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceKey` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`governorate` varchar(80) NOT NULL,
	`directorate` varchar(255) NOT NULL,
	`locality` varchar(500),
	`latitude` double,
	`longitude` double,
	`mapUrl` varchar(500),
	`dataYear` int NOT NULL,
	`sourceLicense` varchar(160) NOT NULL,
	`sourceRefs` json NOT NULL,
	`importedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `official_mosques_id` PRIMARY KEY(`id`),
	CONSTRAINT `official_mosques_source_key_uq` UNIQUE(`sourceKey`)
);
--> statement-breakpoint
ALTER TABLE `places` ADD `sourceKey` varchar(64);--> statement-breakpoint
ALTER TABLE `places` ADD `sourceUrl` varchar(500);--> statement-breakpoint
ALTER TABLE `places` ADD CONSTRAINT `places_sourceKey_unique` UNIQUE(`sourceKey`);--> statement-breakpoint
CREATE INDEX `oauth_state_expires_at_idx` ON `oauth_state_nonces` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `official_mosques_name_idx` ON `official_mosques` (`name`);--> statement-breakpoint
CREATE INDEX `official_mosques_governorate_idx` ON `official_mosques` (`governorate`);