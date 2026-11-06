CREATE TABLE `favorite_place_keys` (
	`userId` int NOT NULL,
	`favoriteKey` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `favorite_place_keys_userId_favoriteKey_pk` PRIMARY KEY(`userId`,`favoriteKey`)
);
--> statement-breakpoint
ALTER TABLE `favorite_place_keys` ADD CONSTRAINT `favorite_place_keys_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `favorite_place_keys_key_idx` ON `favorite_place_keys` (`favoriteKey`);
--> statement-breakpoint
INSERT IGNORE INTO `favorite_place_keys` (`userId`, `favoriteKey`)
SELECT `userId`, CONCAT('community:', `placeId`) FROM `favorites`;
