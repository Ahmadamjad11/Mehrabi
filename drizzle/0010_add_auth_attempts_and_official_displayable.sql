ALTER TABLE `auth_tokens` ADD `attemptCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `official_mosques` ADD `displayable` boolean DEFAULT true NOT NULL;