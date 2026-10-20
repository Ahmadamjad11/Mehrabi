ALTER TABLE `auth_tokens` ADD CONSTRAINT `auth_tokens_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `favorites` ADD CONSTRAINT `favorites_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `favorites` ADD CONSTRAINT `favorites_placeId_places_id_fk` FOREIGN KEY (`placeId`) REFERENCES `places`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_placeId_places_id_fk` FOREIGN KEY (`placeId`) REFERENCES `places`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `auth_tokens_user_idx` ON `auth_tokens` (`userId`);--> statement-breakpoint
CREATE INDEX `favorites_place_idx` ON `favorites` (`placeId`);--> statement-breakpoint
CREATE INDEX `reviews_place_idx` ON `reviews` (`placeId`);--> statement-breakpoint
CREATE INDEX `reviews_user_idx` ON `reviews` (`userId`);