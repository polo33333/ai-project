SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'KnowledgeHubLocalEval'
    THROW 51000, 'Refusing to reset: current database must be KnowledgeHubLocalEval.', 1;

BEGIN TRANSACTION;

DROP TABLE IF EXISTS dbo.KH_EvalElectricity;
DROP TABLE IF EXISTS dbo.KH_EvalContract;
DROP TABLE IF EXISTS dbo.KH_EvalCustomer;

CREATE TABLE dbo.KH_EvalCustomer (
    CustomerID int NOT NULL PRIMARY KEY,
    CustomerCode varchar(10) NOT NULL UNIQUE,
    CustomerName nvarchar(100) NOT NULL,
    Region nvarchar(20) NOT NULL,
    IsActive bit NOT NULL
);

CREATE TABLE dbo.KH_EvalContract (
    ContractID int NOT NULL PRIMARY KEY,
    ContractNo varchar(20) NOT NULL UNIQUE,
    CustomerID int NOT NULL REFERENCES dbo.KH_EvalCustomer(CustomerID),
    StartDate date NOT NULL,
    EndDate date NOT NULL,
    TotalValue decimal(18,2) NOT NULL,
    Status varchar(20) NOT NULL
);

CREATE TABLE dbo.KH_EvalElectricity (
    ElectricityID int NOT NULL PRIMARY KEY,
    ReadingDate date NOT NULL,
    CustomerID int NOT NULL REFERENCES dbo.KH_EvalCustomer(CustomerID),
    TotalQty decimal(18,2) NOT NULL,
    Amount decimal(18,2) NOT NULL
);

INSERT dbo.KH_EvalCustomer (CustomerID, CustomerCode, CustomerName, Region, IsActive) VALUES
    (1, 'C001', N'Công ty An Phát', N'Miền Bắc', 1),
    (2, 'C002', N'Công ty Bình Minh', N'Miền Nam', 1),
    (3, 'C003', N'Công ty Cửu Long', N'Miền Nam', 0),
    (4, 'C004', N'Công ty Đông Á', N'Miền Bắc', 1);

INSERT dbo.KH_EvalContract (ContractID, ContractNo, CustomerID, StartDate, EndDate, TotalValue, Status) VALUES
    (1, 'HD-001', 1, '2025-01-01', '2027-12-31', 1000000, 'active'),
    (2, 'HD-002', 2, '2026-02-01', '2026-12-31', 2000000, 'active'),
    (3, 'HD-003', 4, '2024-01-01', '2024-12-31', 500000, 'expired'),
    (4, 'HD-004', 1, '2026-03-01', '2028-02-29', 1500000, 'active');

INSERT dbo.KH_EvalElectricity (ElectricityID, ReadingDate, CustomerID, TotalQty, Amount) VALUES
    (1, '2026-01-15', 1, 1000, 2000000),
    (2, '2026-01-15', 2, 1200, 2400000),
    (3, '2026-02-15', 1, 800, 1600000),
    (4, '2026-02-15', 4, 500, 1000000),
    (5, '2026-03-15', 1, 700, 1400000),
    (6, '2025-12-15', 2, 900, 1800000);

COMMIT TRANSACTION;
