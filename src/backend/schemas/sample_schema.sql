-- ============================================================================
-- KnowledgeHub AI - Sample SQL Server Schema (DDL Script for Testing)
-- Database: DB_QuanLyKinhDoanh (Read-Only Knowledge Source)
-- ============================================================================

-- 1. Bảng PhongBan (Department)
CREATE TABLE PhongBan (
    PhongBanID INT PRIMARY KEY IDENTITY(1,1),
    TenPhongBan NVARCHAR(100) NOT NULL,
    MaPhongBan VARCHAR(20) UNIQUE NOT NULL,
    TruongPhongID INT NULL
);

-- 2. Bảng NhanVien (Employees)
CREATE TABLE NhanVien (
    NhanVienID INT PRIMARY KEY IDENTITY(1,1),
    MaNV VARCHAR(20) UNIQUE NOT NULL,
    HoTen NVARCHAR(100) NOT NULL,
    ChucVu NVARCHAR(50),
    LuongCoBan DECIMAL(18,2) DEFAULT 0,
    NgayVaoLam DATE,
    PhongBanID INT FOREIGN KEY REFERENCES PhongBan(PhongBanID)
);

-- 3. Bảng KhachHang (Customers)
CREATE TABLE KhachHang (
    KhachHangID INT PRIMARY KEY IDENTITY(1,1),
    MaKH VARCHAR(20) UNIQUE NOT NULL,
    TenKhachHang NVARCHAR(150) NOT NULL,
    SoDienThoai VARCHAR(15),
    Email VARCHAR(100),
    DiaChi NVARCHAR(250)
);

-- 4. Bảng HoaDon (Invoices/Sales)
CREATE TABLE HoaDon (
    HoaDonID INT PRIMARY KEY IDENTITY(1,1),
    MaHD VARCHAR(30) UNIQUE NOT NULL,
    NgayLap DATETIME DEFAULT GETDATE(),
    KhachHangID INT FOREIGN KEY REFERENCES KhachHang(KhachHangID),
    NhanVienBanID INT FOREIGN KEY REFERENCES NhanVien(NhanVienID),
    TongTien DECIMAL(18,2) NOT NULL DEFAULT 0,
    TrangThai NVARCHAR(30) DEFAULT N'DaThanhToan'
);

-- 5. Bảng ChiTietHoaDon (Invoice Items)
CREATE TABLE ChiTietHoaDon (
    ChiTietID INT PRIMARY KEY IDENTITY(1,1),
    HoaDonID INT FOREIGN KEY REFERENCES HoaDon(HoaDonID),
    TenSanPham NVARCHAR(150) NOT NULL,
    SoLuong INT NOT NULL DEFAULT 1,
    DonGia DECIMAL(18,2) NOT NULL,
    ThanhTien AS (SoLuong * DonGia)
);
