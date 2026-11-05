CREATE TABLE `place_name_suggestions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`source` enum('community','official','osm') NOT NULL,
	`sourceKey` varchar(255) NOT NULL,
	`targetKind` enum('mosque','musalla') NOT NULL,
	`currentName` varchar(255) NOT NULL,
	`suggestedName` varchar(255) NOT NULL,
	`targetArea` varchar(500),
	`targetLatitude` double,
	`targetLongitude` double,
	`targetUrl` varchar(500),
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`activeRequestKey` varchar(64),
	`reviewedBy` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `place_name_suggestions_id` PRIMARY KEY(`id`),
	CONSTRAINT `place_name_suggestions_active_uq` UNIQUE(`activeRequestKey`)
);
--> statement-breakpoint
ALTER TABLE `places` ADD `displayName` varchar(255);--> statement-breakpoint
ALTER TABLE `place_name_suggestions` ADD CONSTRAINT `place_name_suggestions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `place_name_suggestions` ADD CONSTRAINT `place_name_suggestions_reviewedBy_users_id_fk` FOREIGN KEY (`reviewedBy`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `place_name_suggestions_status_created_idx` ON `place_name_suggestions` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `place_name_suggestions_target_idx` ON `place_name_suggestions` (`source`,`sourceKey`);