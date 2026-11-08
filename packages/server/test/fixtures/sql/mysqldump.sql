-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
--
-- Host: localhost    Database: shop
-- ------------------------------------------------------
-- Server version 8.0.36

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;

--
-- Table structure for table `customers`
--

DROP TABLE IF EXISTS `customers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `balance` decimal(12,2) DEFAULT '0.00',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(6) DEFAULT NULL,
  `prefs` json DEFAULT NULL,
  `avatar` blob,
  `score` double DEFAULT NULL,
  `big` bigint unsigned DEFAULT NULL,
  `born` date DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name_idx` (`name`),
  KEY `created_idx` (`created_at`),
  CONSTRAINT `customers_chk` CHECK ((`balance` >= -1000))
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='it''s; a \'table\'';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `customers`
--

LOCK TABLES `customers` WRITE;
/*!40000 ALTER TABLE `customers` DISABLE KEYS */;
INSERT INTO `customers` VALUES (1,'Ali O\'Brien',1234.50,1,'2026-01-02 03:04:05.123456','{\"tags\": [\"a\", \"b\"], \"n\": 5}',0x0102FF,1.5,18446744073709551615,'1990-05-06'),(2,'Ayşe\\Line\nTwo',-0.01,0,'0000-00-00 00:00:00',NULL,NULL,-2.5e-3,42,NULL),(3,'Tab\there; semi \"q\" \Z\0end',0.00,1,NULL,'not json',X'',NULL,NULL,'0000-00-00');
/*!40000 ALTER TABLE `customers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `events`
--

DROP TABLE IF EXISTS `events`;
CREATE TABLE `events` (
  `id` bigint NOT NULL,
  `flag` bit(1) DEFAULT NULL,
  `payload` varbinary(16) DEFAULT NULL,
  `count` int DEFAULT NULL,
  `at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 /*!50100 PARTITION BY HASH (`id`) PARTITIONS 2 */;

# a MySQL hash comment; with a semicolon and a quote '
LOCK TABLES `events` WRITE;
INSERT INTO `events` (`id`, `flag`, `payload`, `count`, `at`) VALUES (10,b'1',_binary 'a\0b','7','2026-05-06 07:08:09'),(11,b'0',NULL,'abc',NULL),(12,NULL,NULL,now(),NULL),(13,NULL,NULL),(14,NULL,NULL,DEFAULT,NULL) ON DUPLICATE KEY UPDATE `count`=VALUES(`count`);
UNLOCK TABLES;

DELIMITER ;;
CREATE DEFINER=`root`@`localhost` PROCEDURE `fill`()
BEGIN
  INSERT INTO `events` VALUES (99,NULL,NULL,NULL,NULL);
  SELECT 'it''s; done';
END ;;
DELIMITER ;
/*!50003 SET @saved_sql_mode = @@sql_mode */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `ev_ai` AFTER INSERT ON `events` FOR EACH ROW BEGIN
  INSERT INTO `customers` VALUES (77,'x',0,0,NULL,NULL,NULL,NULL,NULL,NULL);
END */;;
DELIMITER ;
/*!40000 INSERT INTO `customers` VALUES (88,'never',0,0,NULL,NULL,NULL,NULL,NULL,NULL) */;

/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;
/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;

-- Dump completed on 2026-10-10 12:00:00
