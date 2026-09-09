export interface Tenant {
  id: string;
  name: string;
  branch: string;
  active?: boolean;
  createdAt?: string;
}

// Peran pengguna (RBAC). super_admin lintas-tenant (operator SaaS);
// sisanya tercakup dalam satu tenant/perusahaan.
export type UserRole =
  | "super_admin" // kelola semua perusahaan & user (operator sistem)
  | "admin"       // admin perusahaan: kelola user, master data, template, settings
  | "legal"       // Legal Counsel: kelola klausul & template
  | "manager"     // Supervisor: kelola kontrak & aktivasi
  | "staff"       // Staff GA/HR: buat/edit draft, upload, aktifkan kontrak
  | "viewer";     // hanya baca

export interface User {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  lastLoginAt?: string;
  // Lupa password: hash (bukan token mentah) + waktu kadaluarsa token reset.
  // Token mentah hanya pernah ada di email yang dikirim & di request user —
  // tidak pernah disimpan mentah agar kebocoran DB tidak otomatis membuka akun.
  resetTokenHash?: string;
  resetTokenExpiresAt?: string;
  // DELEGASI PERSETUJUAN — dipakai saat approver berhalangan (cuti/dinas).
  // Tanpa ini dokumen mandek total di satu langkah sampai orangnya kembali.
  // Rentang tanggal WAJIB dibatasi: delegasi tanpa akhir sama saja memindahkan
  // wewenang secara permanen tanpa jejak yang disengaja.
  // Delegasi TIDAK berantai — kalau si pengganti juga sedang mendelegasikan,
  // wewenangnya berhenti di dia (lihat resolveDelegate di server.ts).
  delegateToId?: string;
  delegateToName?: string; // didenormalisasi, pola sama seperti approverName
  delegateFrom?: string;   // YYYY-MM-DD, inklusif
  delegateUntil?: string;  // YYYY-MM-DD, inklusif
  delegateReason?: string;
  // 2FA (TOTP, RFC 6238). totpSecret HANYA terisi setelah setup dikonfirmasi
  // dengan kode yang benar (lihat POST /api/auth/2fa/confirm) — secret yang
  // digenerate tapi belum pernah diverifikasi tidak pernah membuat
  // totpEnabled jadi true, supaya orang tidak terkunci dari akunnya sendiri
  // gara-gara salah scan QR lalu keburu logout.
  totpSecret?: string;
  totpEnabled?: boolean;
  // Hash SHA-256 kode cadangan yang belum terpakai — kode mentahnya cuma
  // pernah ditampilkan sekali ke user saat 2FA diaktifkan, tidak pernah
  // disimpan mentah (pola sama seperti passwordHash).
  totpBackupCodeHashes?: string[];
}

// Bentuk user yang aman dikirim ke frontend (tanpa passwordHash / reset token)
export type SafeUser = Omit<User, "passwordHash" | "resetTokenHash" | "resetTokenExpiresAt" | "totpSecret" | "totpBackupCodeHashes">;

export interface Clause {
  id: string;
  tenantId?: string;
  title: string;
  content: string;
  category: string; // e.g. "Vendor", "Employment", "NDA", "General"
  tags: string[];
  isMandatory: boolean;
  isProtected: boolean; // Jika true, user non-legal tidak boleh mengubah isinya
  version: number;
}

export interface Variable {
  key: string; // e.g. "CompanyName"
  tenantId?: string;
  label: string;
  type: "string" | "number" | "date";
  description: string;
  defaultValue?: string;
}

export interface Template {
  id: string;
  tenantId?: string;
  name: string;
  description: string;
  // String bebas (bukan union) — sudah dinamis di runtime lewat clauseCategories
  // (Konfigurasi > Kategori, dikelola via /api/clause-categories), sama seperti
  // Contract.category. Union lama sudah tidak akurat vs perilaku aktual.
  category: string;
  clauseIds: string[]; // Klausul yang menyusun template ini
  requiredVariables: string[]; // Variabel yang wajib diisi
  parties: string[]; // e.g. ["Pihak Pertama (Perusahaan)", "Pihak Kedua (Mitra)"]
  // Opsional — override kalimat pembuka/penutup dokumen (substitusi {{Variable}}
  // via renderClauseContent seperti klausul). Kosong = pakai kalimat default
  // bawaan sistem. Dipakai terutama oleh template Addendum yang perlu redaksi
  // beda dari perjanjian baru, tapi berlaku untuk kategori apa pun.
  openingParagraph?: string;
  closingParagraph?: string;
  // Override kalimat recital "Bahwa PARA PIHAK telah membuat dan
  // menandatangani..." yang cuma dicetak untuk dokumen Addendum (lihat
  // selectedContractAddendumInfo di App.tsx) — kosong = pakai kalimat
  // default bawaan sistem. Dukung token {{ParentDocType}}, {{ParentNumber}},
  // {{ParentDate}}, {{ParentEndDate}}, {{PreviousOrdinal}}, {{PreviousNumber}},
  // {{PreviousDate}} lewat renderClauseContent, terisi otomatis dari data
  // kontrak induk/addendum sebelumnya saat dokumen ini dicetak.
  addendumRecitalParagraph?: string;
  // VERSI TEMPLATE. Template diedit di tempat, jadi tanpa penanda versi tidak
  // ada cara tahu kontrak lama disusun dari redaksi yang mana. Dinaikkan HANYA
  // ketika field yang benar-benar memengaruhi isi dokumen berubah (paragraf
  // pembuka/penutup/recital, susunan klausul, pihak) — mengganti deskripsi
  // atau nama tidak menaikkan versi.
  version?: number;
  updatedAt?: string;
  updatedByName?: string;
}

// Potret redaksi template PADA SAAT kontrak dibuat. Mengikuti pola yang sudah
// dipakai ContractVendorSnapshot: kalau template diubah belakangan, dokumen
// yang sudah terlanjur dibuat TIDAK ikut berubah redaksinya.
//
// Ini bukan sekadar fitur "riwayat": sebelum ada snapshot, mengedit paragraf
// pembuka sebuah template diam-diam mengubah pembuka SEMUA kontrak lama yang
// memakai template itu, termasuk yang sudah aktif dan ditandatangani.
export interface ContractTemplateSnapshot {
  templateId: string;
  templateName: string;
  version: number;
  capturedAt: string;
  openingParagraph?: string;
  closingParagraph?: string;
  addendumRecitalParagraph?: string;
}

// Siklus hidup: Draft (bisa diedit) → OnReview (diajukan ke 2 penanggung
// jawab berurutan, terkunci dari editing) → FullyApproved (kedua approver
// setuju, dokumen boleh diunduh untuk TTD basah) → Aktif (setelah diaktifkan,
// masuk monitoring & reminder) → Archived/Terminated. Status legacy dari era
// TTD/approval lama (Request/Review/Approval/Approved/Signature/Signed)
// dipetakan otomatis oleh migrasi boot di server.ts (migrateLegacyContracts)
// — SENGAJA nama status baru di sini ("OnReview"/"FullyApproved") beda dari
// nama legacy tsb ("Review"/"Approved") supaya migrasi boot itu tidak
// menimpanya balik secara tidak sengaja (lihat statusMap di server.ts).
// TidakAktif: transisi OTOMATIS (bukan manual lewat PUT) dari Aktif ketika
// endDate terlewati — lihat reminders.ts runReminderCheck. Beda dari
// Archived/Terminated (yang selalu keputusan manusia eksplisit): TidakAktif
// murni penanda "sudah lewat masa berlaku, belum ada tindak lanjut" — dari
// sini manusia baru memutuskan mau di-renew, Archived, atau Terminated.
export type ContractStatus = "Draft" | "OnReview" | "FullyApproved" | "Aktif" | "TidakAktif" | "Archived" | "Terminated";

export interface ContractParty {
  role: string; // dari Template.parties
  name: string;
  email?: string;
  // String bebas (bukan union) supaya daftar tipe pihak bisa dikonfigurasi
  // dinamis per tenant lewat masterData.partyTypes, tanpa migrasi kode.
  type?: string;
}

// Rangkap fisik sebuah kontrak. Praktik umum di Indonesia: kontrak dibuat
// rangkap 2 bermeterai cukup — rangkap pertama meterai dibubuhkan di sisi
// tanda tangan Pihak Pertama, rangkap kedua di sisi Pihak Kedua, dan tiap
// pihak memegang satu rangkap asli. Setiap rangkap dilacak terpisah:
// label posisi meterai, siapa pemegangnya, status fisiknya (disimpan /
// dikirim / di-assign), dan scan berkasnya masing-masing.
export interface ContractCopy {
  index: number;          // 1 atau 2
  label: string;          // e.g. "Rangkap 1 — Meterai pada Pihak Pertama"
  materaiOn?: string;     // pihak tempat meterai dibubuhkan (kosong = tanpa meterai)
  heldBy: string;         // pemegang rangkap ini (default: pihak ke-index)
  status: string;         // dari masterData.copyStatuses (default "Disimpan")
  assignedTo?: string;    // penerima, jika status Dikirim / Di-assign
  fileUrl?: string;       // scan/berkas rangkap ini (upload terpisah per rangkap)
  updatedAt?: string;
}

export interface Contract {
  id: string;
  tenantId: string;
  templateId: string;
  contractNumber: string;
  title: string;
  category: string;
  party1Name: string; // Legacy
  party2Name: string; // Legacy
  party2Type: string; // Legacy — string bebas agar tipe pihak bisa dikonfigurasi dinamis
  parties: ContractParty[]; // Dynamic parties
  startDate: string;
  endDate: string;
  contractValue: number;
  currency: string;
  status: ContractStatus;
  variables: Record<string, string>; // Isian variabel aktual { "EmployeeName": "Andi", ... }
  // Klausa spesifik untuk kontrak ini. titleEn/contentEn diisi hasil
  // terjemahan AI (lihat /api/contracts/:id/translate) dan hanya dipakai saat
  // documentLanguage = "en" atau "bilingual" — teks sumber (title/content)
  // TIDAK pernah ditimpa, supaya terjemahan bisa dibuat ulang kapan saja.
  clauses: { id: string; title: string; content: string; order: number; titleEn?: string; contentEn?: string }[];
  // Bahasa dokumen: "id" (default, perilaku lama) | "en" (tampil Inggris) |
  // "bilingual" (dua kolom Indonesia|Inggris, jatuh ke gaya berselang untuk
  // pasal yang terlalu panjang). Kosong/undefined = "id".
  documentLanguage?: "id" | "en" | "bilingual";
  // Tampilkan kop surat (logo+nama+alamat perusahaan) di preview/export PDF.
  // Kosong/undefined = true (perilaku lama, tampil). Kontrak KERJASAMA dua
  // pihak yang sejajar (bukan surat sepihak dari satu pihak) sering sengaja
  // dimatikan — kop surat salah satu pihak bisa kesan berat sebelah, dan
  // mematikannya juga menghemat ~30mm ruang vertikal per halaman.
  showLetterhead?: boolean;
  // Bahasa ASLI yang diketik user. Menentukan arah terjemahan: kalau sumbernya
  // "en", maka yang diterjemahkan justru ke Indonesia. Kosong = "id".
  sourceLanguage?: "id" | "en";
  translationUpdatedAt?: string; // kapan terjemahan terakhir dibuat
  translationSimulated?: boolean; // true jika AI tidak aktif & isi terjemahan hanya placeholder
  // Judul pasal (atau "Narasi Pembuka") yang GAGAL diterjemahkan otomatis
  // karena token {{Variabel}} berubah/hilang di hasil AI — pasal itu tetap
  // tampil bahasa aslinya (lihat /api/contracts/:id/translate) sampai
  // diterjemahkan ulang atau dikoreksi manual.
  translationWarnings?: string[];
  preambleEn?: string; // terjemahan narasi pembuka (dipakai mode en/bilingual) — BISA diedit manual di editor
  // Salinan hasil AI translate ASLI untuk preambleEn di atas, TIDAK PERNAH
  // ikut diedit manual — dipakai tombol "Kembalikan ke bawaan" di editor EN
  // supaya user bisa balik ke hasil terjemahan AI kalau editannya sendiri
  // ternyata salah, tanpa perlu menerjemahkan ulang seluruh dokumen (yang
  // akan ikut menimpa editan manual di pasal lain). Diisi bersamaan dengan
  // preambleEn tiap kali /translate sukses (lihat server.ts).
  preambleEnOriginal?: string;
  titleEn?: string; // terjemahan judul dokumen (header) — dipakai mode en/bilingual
  docTypeEn?: string; // terjemahan jenis surat, mis. "Cooperation Agreement Letter" — dipakai mode en/bilingual
  // Terjemahan paragraf KHUSUS ADDENDUM (recital "Bahwa PARA PIHAK telah
  // membuat dan menandatangani..." & penutup "Demikian Addendum ini dibuat
  // dan ditandatangani..."). Hanya terisi kalau kontrak ini addendum
  // (amendsContractId ada) dan sudah pernah lewat /translate versi baru.
  // Token {{ParentDocType}}/{{ParentNumber}}/dll TETAP ada di teks hasil
  // terjemahan (tidak disubstitusi di server) — disubstitusi saat render,
  // sama seperti preambleEn.
  addendumRecitalEn?: string;
  closingParagraphEn?: string;
  masterPdfUrl?: string; // Optional URL for uploaded master contract PDF
  numberSeq?: number; // Nomor urut yang dikonsumsi dari counter persisten (per jenis+tahun) — dipakai sbg baseline anti-duplikat
  docType?: string; // Jenis dokumen saat pendaftaran arsip (Perjanjian, MOU, Addendum, dll)
  notes?: string; // Catatan bebas dari form pendaftaran dokumen
  exportedPdfUrl?: string; // Hasil export PDF yang di-host server untuk dibagikan via email/WA
  exportedPdfKey?: string; // Kunci storage berkas export di atas — dipakai fetch ulang server-side (mis. lampiran email)
  ocrText?: string; // Teks lengkap hasil OCR dari dokumen scan/hardcopy
  ocrSimulated?: boolean; // true jika hasil OCR berasal dari mode simulasi (tanpa API key AI)
  lastReminderDate?: string; // Tanggal (YYYY-MM-DD) terakhir reminder proaktif dikirim — cegah notifikasi duplikat per hari
  renewedFromId?: string; // id kontrak asal jika ini adalah draft perpanjangan — mencegah duplikasi draft renew
  // id kontrak INDUK yang diamandemen jika kontrak ini adalah Addendum — beda
  // semantik dari renewedFromId (renew = pengganti baru; addendum = dokumen
  // satelit yang mendokumentasikan pasal berubah, induknya tetap hidup).
  // Nomor urut addendum ("Addendum Kesebelas") DIHITUNG dari data (count
  // kontrak lain dengan amendsContractId sama), bukan disimpan di sini.
  amendsContractId?: string;
  // Lampiran rincian opsional pada Addendum (mis. tabel perhitungan biaya).
  // Kosong/tidak ada = section lampiran tidak dicetak sama sekali di preview.
  amendmentAttachments?: { label: string; satuan?: string; jumlah?: string; keterangan?: string }[];
  subFolderId?: string; // id SubFolder (sub/sub-sub folder) tempat kontrak ini diarsipkan, di bawah `category`
  copies?: ContractCopy[]; // rangkap fisik kontrak (1 atau 2) + posisi meterai per rangkap
  // Sharing fee opsional — kosong/tidak ada = kontrak ini tidak punya skema
  // bagi hasil (mayoritas kontrak internal/Employment memang tidak perlu ini).
  sharingFeeItems?: ContractSharingFeeItem[];
  // Jadwal termin pembayaran + realisasinya. Kosong = kontrak ini memang tidak
  // dilacak pembayarannya (mis. NDA, dokumen legalitas) — bukan berarti belum
  // diisi, jadi UI tidak boleh menuntutnya.
  paymentTerms?: ContractPaymentTerm[];
  // Kewajiban non-finansial yang lahir dari kontrak ini. Kosong = tidak ada
  // yang perlu dilacak, bukan berarti belum diisi.
  obligations?: ContractObligation[];
  // --- RETENSI & PEMUSNAHAN ARSIP ---
  // legalHold MEMBLOKIR pemusnahan sepenuhnya, terlepas dari masa retensi —
  // untuk dokumen yang sedang jadi objek sengketa/audit/somasi. Ini keputusan
  // MANUSIA eksplisit, tidak pernah diturunkan otomatis dari data lain.
  legalHold?: boolean;
  legalHoldReason?: string;
  legalHoldSetByName?: string;
  legalHoldSetAt?: string;
  // Pencatatan bahwa pemusnahan sudah dilakukan sesuai kebijakan retensi.
  // SENGAJA tidak ada endpoint yang benar-benar menghapus row kontrak ini —
  // praktik standar records management (ISO 15489): bukti bahwa sesuatu
  // pernah dimusnahkan harus tetap tercatat, bukan hilang begitu saja. Kalau
  // dihapus total, tidak ada cara membuktikan pemusnahan itu memang sesuai
  // jadwal & kebijakan, bukan sekadar data hilang.
  destroyedAt?: string;
  destroyedByName?: string;
  destroyedNote?: string;
  // Evaluasi kinerja vendor untuk kontrak ini — kosong = belum dievaluasi.
  // Hanya bermakna kalau kontrak ini punya vendorSnapshot (dibuat dengan
  // memilih vendor dari master data, bukan mengetik nama bebas).
  vendorEvaluation?: ContractVendorEvaluation;
  // Checksum SHA-256 dari berkas bukti tanda tangan (upload saat aktivasi),
  // dihitung SAAT itu juga. TEGAS BUKAN e-meterai atau tanda tangan
  // elektronik resmi — itu perlu penyedia berizin PERURI (Privy/Digisign/
  // TekenAja dst) dengan verifikasi identitas & API berbayar yang di luar
  // cakupan sistem ini. Ini murni checksum integritas: membuktikan berkas
  // yang tersimpan hari ini persis sama dengan yang diunggah saat aktivasi,
  // tidak lebih. activationProofKey = storage key mentah (bukan URL publik)
  // supaya bisa diambil ulang untuk verifikasi.
  activationProofHash?: string;
  activationProofKey?: string;
  // Snapshot master vendor/customer yang dipilih saat kontrak dibuat (lihat
  // ContractVendorSnapshot) — kosong kalau party2 diisi manual tanpa sync.
  vendorSnapshot?: ContractVendorSnapshot;
  // Potret redaksi template saat kontrak ini dibuat — lihat
  // ContractTemplateSnapshot. Kosong pada kontrak lama (dibuat sebelum fitur
  // ini): rendering jatuh kembali ke template hidup, sama seperti sebelumnya.
  templateSnapshot?: ContractTemplateSnapshot;
  // Approval matrix (2 penanggung jawab berurutan) — approvalSteps SELALU
  // mencerminkan ronde TERKINI (tetap tampil apa adanya setelah FullyApproved/
  // Aktif untuk audit, tidak dikosongkan), approvalHistory berisi ronde yang
  // SUDAH selesai (approve penuh maupun reject).
  approvalSteps?: ContractApprovalStep[];
  approvalRound?: number;
  approvalSubmittedById?: string;
  approvalSubmittedByName?: string;
  approvalHistory?: ContractApprovalRound[];
  createdAt: string;
  updatedAt: string;
  reminderDaysBefore: number; // Kapan start reminder notifikasi (e.g. 30 hari sebelum)
  isAutoRenew: boolean;
  // Review EKSTERNAL via token link (pihak kedua tanpa akun): token acak rahasia,
  // opsional kadaluarsa, dan catatan "OK/Setuju" dari tamu eksternal. Dipakai
  // SEBELUM matriks approval — pihak kedua bisa komentar/coret klausul atau setuju.
  externalReviewToken?: string;
  externalReviewExpiresAt?: string | null;
  externalApprovals?: { name: string; approvedAt: string; note?: string }[];
  // Sudah tanda-tangan eksternal terkunci setelah "Setuju/OK" (lihat
  // externalApprovals) — pemilik dokumen harus klik "Buka Akses Kembali"
  // secara eksplisit sebelum tamu bisa komentar/setuju lagi lewat token yg sama.
  externalReviewLocked?: boolean;
  // Detail pihak (opsional, per-kontrak) untuk narasi pembuka & tanda tangan —
  // bukan cuma nama, tapi alamat/jabatan/nomor identitas penandatangan. Party1
  // kosong = pakai default appSettings.company* (companyAddress dst); Party2
  // tak punya default global (party2Address kosong jatuh ke variables.Address
  // lama untuk kompatibilitas dokumen yang dibuat sebelum field ini ada).
  party1Address?: string;
  party1Position?: string; // jabatan penandatangan Pihak Pertama
  party1IdLabel?: string;  // label nomor identitas bebas, mis. "NPWP"/"NIK"
  party1IdNumber?: string;
  party2Address?: string;
  party2Position?: string;
  party2IdLabel?: string;
  party2IdNumber?: string;
  // Logo Pihak Kedua — OPSIONAL, diunggah manual per-kontrak lewat modal Edit
  // Data Pihak (beda dari appSettings.companyLogoUrl yang global utk Pihak
  // Pertama/perusahaan sendiri, dipakai berulang di semua kontrak). Kosong =
  // kop surat cuma tampilkan 1 logo (Pihak Pertama saja) — TIDAK dianggap
  // error/rusak, ini kondisi normal utk mayoritas kontrak (mis. kerjasama
  // internal antar unit sendiri yang memang tidak butuh identitas kedua).
  party2LogoUrl?: string;
  party2LogoKey?: string;
  party2LogoMimeType?: string;
  // Nyala/matikan GAMBAR logo di kop surat — terpisah dari showLetterhead
  // (yang matikan kop SELURUHNYA termasuk nama/alamat teks). Kosong/undefined
  // = true (tampil, perilaku lama). Dipakai utk kop "teks doang" (nama+alamat
  // perusahaan tanpa gambar logo) tanpa harus mematikan kop surat total.
  showLetterheadLogo?: boolean;
  // Tampilkan kotak placeholder "Meterai Rp10.000" (garis putus-putus) di
  // ruang kosong tanda tangan tiap pihak. Kosong/undefined = false (tidak
  // tampil, perilaku lama) — ini FITUR OPT-IN, bukan default baru, karena
  // banyak perusahaan sudah punya meterai tempel fisik/e-meterai sendiri di
  // luar template ini. TIDAK menambah tinggi halaman sama sekali kalau
  // dinyalakan — cuma mengisi ruang kosong TTD yang memang sudah ada.
  showMeteraiPlaceholder?: boolean;
  // Override narasi pembuka KHUSUS kontrak ini (prioritas TERTINGGI di atas
  // Template.openingParagraph & masterData.categoryOpeningParagraphs) —
  // diisi langsung di wizard/form registrasi. Kosong = ikuti rantai fallback
  // biasa. Sama seperti field ini di masterData: token {{...}}, **tebal**,
  // paragraf baru via baris kosong ganda.
  customOpeningParagraph?: string;
}

export interface ContractApprovalStep {
  id: string;
  order: number; // 1..N — matriks approval kini fleksibel (dulu selalu 2 langkah)
  approverId: string;
  approverName: string; // denormalized (pola sama seperti AuditTrail/ClauseComment)
  approverRole: string;
  decision: "pending" | "approved" | "rejected";
  comment?: string;
  decidedAt?: string;
  // Diisi HANYA bila keputusan dijalankan oleh pengganti (delegasi), bukan oleh
  // approver yang ditunjuk. Langkahnya tetap tercatat atas nama approver asli —
  // ini penanda siapa yang sebenarnya menekan tombol.
  decidedByDelegateId?: string;
  decidedByDelegateName?: string;
  // Kapan langkah ini MULAI jadi giliran orangnya — dasar penghitungan SLA.
  // Sengaja disimpan, bukan diturunkan dari contract.updatedAt: updatedAt
  // berubah pada setiap penyuntingan apa pun, jadi lama-menunggu yang dihitung
  // darinya akan ter-reset tanpa sebab dan SLA-nya jadi bohong.
  startedAt?: string;
}

export interface ContractApprovalRound {
  round: number;
  steps: ContractApprovalStep[];
  submittedById: string;
  submittedByName: string;
  submittedAt: string;
  outcome: "approved" | "rejected";
  resolvedAt: string;
}

export interface ContractVersion {
  id: string;
  tenantId?: string;
  contractId: string;
  version: number; // e.g. 1, 2, 3
  title: string;
  variables: Record<string, string>;
  clauses: { id: string; title: string; content: string; order: number }[];
  updatedAt: string;
  updatedBy: string;
  comment: string;
}

export interface AuditTrail {
  id: string;
  tenantId?: string;
  contractId?: string;
  contractNumber?: string;
  userId: string;
  userName: string;
  userRole: string;
  action: string; // e.g. "Create Contract", "Modify Clause", "Activate Contract", "Renew"
  details: string;
  timestamp: string;
  ipAddress: string;
}

export interface SystemNotification {
  id: string;
  tenantId?: string;
  title: string;
  message: string;
  type: "info" | "warning" | "success" | "danger";
  createdAt: string;
  read: boolean;
  contractId?: string;
  dcsDocumentId?: string;
  // Bila diisi, notifikasi hanya tampil bagi user-user ini. Kosong/tidak ada =
  // seluruh tenant (perilaku lama, tidak berubah). Dipakai eskalasi SLA supaya
  // teguran keterlambatan tidak disiarkan ke seisi perusahaan.
  targetUserIds?: string[];
}

// Simulasi Modul Integrasi
export interface EmployeeData {
  id: string;
  tenantId?: string;
  name: string;
  position: string;
  department: string;
  salary: number;
  startDate: string;
}

export interface VendorData {
  id: string;
  tenantId?: string;
  name: string;
  picName: string;
  picPhone?: string; // No. WhatsApp PIC — prefill tombol kirim PDF via WA
  email: string;
  npwp: string;
  address: string;
  bankAccountNumber?: string; // Nomor rekening
  bankAccountName?: string; // Nama pemilik rekening
  bankName?: string; // Nama bank
  bankBranch?: string; // Cabang
  pphRatePercent?: number; // % PPh yang dipotong dari pembayaran ke vendor ini
}

// Evaluasi kinerja vendor UNTUK SATU KONTRAK. Disimpan per kontrak (bukan
// langsung sebagai rata-rata di VendorData) karena kinerja bisa beda jauh
// antar proyek/PIC dari vendor yang sama — menyimpan cuma satu angka agregat
// akan menghilangkan konteks kapan/kenapa skornya turun. Halaman Performa
// Vendor yang menghitung rata-ratanya lintas semua kontrak vendor itu.
export interface ContractVendorEvaluation {
  rating: number; // 1-5
  onTimeDelivery?: boolean; // null/undefined = tidak relevan untuk kontrak ini
  disputeCount: number; // jumlah sengketa/komplain formal selama kontrak berjalan
  notes?: string;
  evaluatedByName: string;
  evaluatedAt: string;
}

// Anggaran per kategori/tahun (opsional per departemen), dibandingkan dengan
// total nilai kontrak aktual di panel Anggaran vs Nilai Kontrak. Koleksi
// top-level terpisah (bukan field di Contract) karena anggaran adalah
// keputusan perencanaan yang berdiri sendiri dari kontrak mana pun — ada
// sebelum kontraknya dibuat, dan tetap relevan walau belum ada kontrak sama
// sekali yang mengisinya.
export interface BudgetEntry {
  id: string;
  tenantId: string;
  year: number;
  category: string; // dicocokkan dengan Contract.category
  department?: string;
  amount: number;
  notes?: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

// Satu baris "sharing fee" dalam perjanjian eksternal (Vendor/Customer/MOU/dst).
// Satu kontrak boleh punya BANYAK baris (lebih dari 1 jenis produk/layanan),
// dan tiap baris bebas pilih feeType sendiri — jadi dalam 1 kontrak bisa ada
// campuran baris persentase dan baris nominal sekaligus (bukan 1 toggle
// global per kontrak).
export interface ContractSharingFeeItem {
  id: string;
  productType: string; // nama produk/layanan, e.g. "Konsultasi Implementasi"
  feeType: "percentage" | "nominal";
  value: number; // feeType percentage: 0-100 (%). feeType nominal: Rupiah (atau currency kontrak).
}

// Satu KEWAJIBAN yang lahir dari kontrak: hal yang harus dikerjakan seseorang
// pada tanggal tertentu — laporan bulanan, perpanjangan asuransi, penyerahan
// jaminan, audit berkala.
//
// Beda dari termin pembayaran (yang selalu soal uang) dan dari reminder masa
// berlaku (yang hanya satu tanggal per kontrak): satu kontrak bisa melahirkan
// banyak kewajiban dengan penanggung jawab berbeda-beda.
//
// clauseId sengaja OPSIONAL. Banyak kewajiban nyata berasal dari lampiran atau
// dari kesepakatan lisan yang tidak punya pasal spesifik; memaksakan tautan ke
// pasal hanya akan membuat orang mengisinya asal-asalan.
export interface ContractObligation {
  id: string;
  title: string;            // mis. "Kirim laporan bulanan"
  clauseId?: string;        // pasal sumber, bila memang berasal dari satu pasal
  clauseTitle?: string;     // didenormalisasi, pola sama seperti approverName
  dueDate: string;          // YYYY-MM-DD
  // Kewajiban berulang. "none" = sekali jalan. Saat ditandai selesai, yang
  // berulang otomatis dimajukan ke periode berikutnya — kalau tidak, orang
  // harus membuat ulang 12 baris untuk laporan bulanan satu tahun.
  recurrence: "none" | "monthly" | "quarterly" | "yearly";
  ownerId?: string;         // penanggung jawab (user di tenant ini)
  ownerName?: string;
  status: "open" | "done" | "waived";
  completedAt?: string;
  completedByName?: string;
  notes?: string;
  lastDueNudgeDate?: string; // dedup pengingat, pola sama seperti termin
}

// Satu termin pembayaran beserta realisasinya.
//
// Aturan yang sama seperti sharing fee dipatuhi di sini: nominal dan
// persentase TIDAK PERNAH dijumlah menjadi satu angka mentah. Persentase
// selalu diturunkan dulu ke rupiah memakai contractValue kontraknya
// (lihat terminAmountIDR) — dan bila contractValue belum diisi, baris
// persentase dilaporkan sebagai "belum bisa dihitung", bukan dianggap nol.
export interface ContractPaymentTerm {
  id: string;
  label: string;            // mis. "Termin 1 — DP 30%"
  dueDate: string;          // YYYY-MM-DD, jatuh tempo tagihan
  amountType: "nominal" | "percentage";
  amount: number;           // nominal: rupiah. percentage: 0-100 (% dari contractValue)
  status: "belum" | "ditagih" | "lunas" | "batal";
  invoiceNumber?: string;
  paidDate?: string;        // YYYY-MM-DD
  paidAmount?: number;      // rupiah yang benar-benar diterima (boleh beda dari tagihan)
  notes?: string;
  // Dedup pengingat jatuh tempo, pola sama seperti Contract.lastReminderDate.
  lastDueNudgeDate?: string;
}

// Snapshot data master vendor/customer PADA SAAT kontrak dibuat — bukan live
// join ke VendorData (pola sama seperti approverName/userName yang
// didenormalisasi di tempat lain: kalau data master vendor berubah belakangan,
// bukti apa yang dipakai saat kontrak ini dibuat tidak ikut berubah).
export interface ContractVendorSnapshot {
  vendorId: string;
  name: string;
  npwp?: string;
  picName?: string;
  picPhone?: string;
  email?: string;
  address?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
  bankName?: string;
  bankBranch?: string;
  pphRatePercent?: number;
}

// Komentar per klausul dalam kontrak (kolaborasi / revisi bersama)
export interface ClauseComment {
  id: string;
  tenantId: string;
  contractId: string;
  clauseId: string;       // id klausul spesifik dalam kontrak
  clauseTitle: string;
  userId: string;
  userName: string;
  userRole: string;
  text: string;
  resolved: boolean;
  mentions: string[];     // userId yang di-mention
  createdAt: string;
  updatedAt?: string;
  parentId?: string;      // untuk reply/thread
  // Sorotan gaya MS Word: rentang teks di dalam content klausul yang dikomentari.
  // Kosong = komentar tingkat-klausul (bukan pada rentang tertentu).
  anchor?: { start: number; end: number; quote: string };
  // "strike" = usulan coret (kalimat minta dihapus/direvisi pembuat); default "comment".
  kind?: "comment" | "strike";
  // Komentator EKSTERNAL (pihak kedua tanpa akun) via token link. Saat true,
  // userId = "external", userName = externalName yang diisi tamu.
  external?: boolean;
  externalName?: string;
}

// Push notification subscription (Web Push API)
export interface PushSubscription {
  id: string;
  userId: string;
  tenantId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: string;
}

// Sub-folder tree nested under a top-level category (Kelola Perusahaan >
// Folder Dokumen). Additive on top of the existing flat category system —
// `category` itself stays a flat string (it drives contract-number prefixes,
// analytics breakdowns, and filters elsewhere), this just adds two more
// organizational layers underneath it: folder utama (category) > sub folder
// > sub-sub folder. parentId null = direct child of the category (a "sub
// folder"); parentId set = child of another SubFolder (a "sub-sub folder").
// Depth is capped at 2 levels below the category by validation, not by the
// data shape, so it can't recurse indefinitely.
export interface SubFolder {
  id: string;
  tenantId: string;
  category: string; // which top-level folder (category) this tree belongs to
  parentId: string | null;
  name: string;
  createdAt: string;
}

// Satu langkah dalam diagram alir SOP yang dibuat langsung di aplikasi
// (flow builder). Dua model koeksis di sini:
//   - Model GRAF (baru): edge eksplisit (nextId/yesId/noId) memetakan graf
//     sungguhan — decision bisa bercabang ke DUA kotak nyata, dan sebuah step
//     boleh menunjuk balik ke step sebelumnya (loop-back), tidak cuma maju.
//     Posisi render dihitung dari BFS-layering atas edge ini (lihat
//     layoutFlowGraph di dcs/pdf-compose.ts), bukan dari `order`.
//   - Model LEGACY (lama, tetap didukung): kalau TIDAK ADA step yang punya
//     nextId/yesId/noId terisi, render jatuh ke perilaku lama — linier
//     mengikuti `order` naik, "Tidak" cuma label teks ke `noTargetOrder`.
//     Ini menjaga dokumen yang sudah pernah di-compose sebelum model graf
//     ada tetap tercetak identik, tanpa migrasi data.
export interface FlowStep {
  id?: string;             // stabil, dipakai sbg target edge (nextId/yesId/noId).
                            // Opsional karena dokumen lama tidak punya ini.
  order: number;            // urutan di list authoring builder; TIDAK lagi
                            // dipakai utk posisi render saat mode graf aktif.
  type: "start" | "process" | "decision" | "end";
  text: string;
  actor?: string;         // pelaksana step (role/departemen), opsional
  color?: string;         // hex kustom kotak (border/isi) — kosong = palet default per-type
  textColor?: string;     // hex kustom warna teks — kosong = default
  nextId?: string;        // model graf: target lanjutan (start/process/end tak dipakai)
  yesId?: string;         // model graf, khusus decision: cabang "Ya"
  noId?: string;          // model graf, khusus decision: cabang "Tidak"
  noTargetOrder?: number; // model LEGACY saja: step tujuan (by order) saat "Tidak"
  // Geser manual kotak (drag) di preview — mode graf saja. FRAKSI (dari 1
  // lebar-lane / 1 tinggi-row), RELATIF terhadap posisi auto-computed
  // {laneIndex,row}, BUKAN piksel absolut. Kenapa fraksi: preview client
  // (SVG, LANE_W=160/NODE_H=56/GAP=40) dan PDF compose (dcs/pdf-compose.ts,
  // laneW dinamis dari lebar halaman, nodeH=40/gap=30) pakai dua sistem unit
  // yang tidak compatible tanpa kode konversi — fraksi berarti hal yang sama
  // secara visual di kedua renderer, masing-masing tinggal kalikan konstanta
  // lokalnya sendiri. Undefined = posisi auto-layout murni (default).
  manualOffset?: { dxLane: number; dyRow: number };
  // Penanggung jawab (Person In Charge) — dipetakan ke kolom "PIC" pada gaya
  // diagram tabel DCS (lihat drawFlowDiagramTable di dcs/pdf-compose.ts);
  // tidak dipakai gaya grafis.
  pic?: string;
}

