CREATE TABLE `osm_place_overrides` (
	`osmKey` varchar(40) NOT NULL,
	`displayName` varchar(255),
	`hoursMode` enum('prayer_times','weekly','unknown') NOT NULL DEFAULT 'unknown',
	`weeklyHours` json,
	`isTemporarilyClosed` boolean NOT NULL DEFAULT false,
	`updatedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `osm_place_overrides_osmKey` PRIMARY KEY(`osmKey`)
);
--> statement-breakpoint
ALTER TABLE `official_mosques` ADD `displayName` varchar(255);--> statement-breakpoint
ALTER TABLE `official_mosques` ADD `hoursMode` enum('prayer_times','weekly','unknown') DEFAULT 'prayer_times' NOT NULL;--> statement-breakpoint
ALTER TABLE `official_mosques` ADD `weeklyHours` json;--> statement-breakpoint
ALTER TABLE `official_mosques` ADD `isTemporarilyClosed` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `official_mosques` ADD `contentUpdatedBy` int;--> statement-breakpoint
ALTER TABLE `places` ADD `hoursMode` enum('prayer_times','weekly','unknown') DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `places` ADD `weeklyHours` json;--> statement-breakpoint
ALTER TABLE `places` ADD `isTemporarilyClosed` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `places` ADD `contentUpdatedBy` int;--> statement-breakpoint
ALTER TABLE `osm_place_overrides` ADD CONSTRAINT `osm_place_overrides_updatedBy_users_id_fk` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `official_mosques` ADD CONSTRAINT `official_mosques_contentUpdatedBy_users_id_fk` FOREIGN KEY (`contentUpdatedBy`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `places` ADD CONSTRAINT `places_contentUpdatedBy_users_id_fk` FOREIGN KEY (`contentUpdatedBy`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;