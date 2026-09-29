CREATE TABLE `favorites` (
	`userId` int NOT NULL,
	`placeId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `favorites_userId_placeId_pk` PRIMARY KEY(`userId`,`placeId`)
);
--> statement-breakpoint
CREATE TABLE `places` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`nameEn` varchar(255),
	`type` enum('mosque','musalla','station','mall') NOT NULL DEFAULT 'mosque',
	`description` text,
	`address` varchar(500),
	`latitude` double NOT NULL,
	`longitude` double NOT NULL,
	`hours` varchar(255) DEFAULT 'مفتوح طوال اليوم',
	`hasAblution` boolean NOT NULL DEFAULT false,
	`hasParking` boolean NOT NULL DEFAULT false,
	`photos` text,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`createdBy` int,
	`reviewedBy` int,
	`reviewedAt` timestamp,
	`averageRating` double NOT NULL DEFAULT 0,
	`ratingsCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `places_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`placeId` int NOT NULL,
	`userId` int NOT NULL,
	`rating` int NOT NULL,
	`comment` text,
	`status` enum('visible','reported','hidden') NOT NULL DEFAULT 'visible',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reviews_id` PRIMARY KEY(`id`)
);
