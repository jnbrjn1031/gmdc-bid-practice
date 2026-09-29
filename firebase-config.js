// ─────────────────────────────────────────────────────────────
//  Firebase 설정
// ─────────────────────────────────────────────────────────────
//  이 파일의 값만 채우면 20명 동시 접속(온라인 모드)이 켜집니다.
//  비워두면 자동으로 "로컬 모드"로 동작합니다.
//    · 로컬 모드 : 한 대의 PC에서 여러 탭으로만 동기화 (연습·시연용)
//    · 온라인 모드: 각자 휴대폰으로 접속 (실제 실습용)
//
//  값 얻는 법은 "설치_가이드.md" 2단계를 보세요.
//  Firebase 콘솔 > 프로젝트 설정 > 내 앱 > SDK 설정 및 구성 에서
//  firebaseConfig 객체를 그대로 복사해 아래에 붙여넣으면 됩니다.
//
//  참고: 아래 값들은 공개되어도 괜찮습니다. 비밀번호가 아니며,
//        실제 보안 경계는 database.rules.json 의 규칙입니다.
// ─────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: "AIzaSyDvEcM1xPzzqgT4O-UK5pXudObL028hu8c",
  authDomain: "bid-practice-5f309.firebaseapp.com",
  databaseURL: "https://bid-practice-5f309-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "bid-practice-5f309",
  storageBucket: "bid-practice-5f309.firebasestorage.app",
  messagingSenderId: "549009077172",
  appId: "1:549009077172:web:5e7ada9173d71864cfb8e1"
};
