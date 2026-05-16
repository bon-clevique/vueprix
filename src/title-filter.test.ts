import { describe, expect, it } from 'vitest';
import { passesTitleWhitelist } from './title-filter.js';

describe('passesTitleWhitelist', () => {
  describe('whitelist 未指定カテゴリ (素通し)', () => {
    it('fixed-list はすべて通す (FIXED_ASINS は別経路で扱われる前提)', () => {
      expect(passesTitleWhitelist('fixed-list', 'コーヒーフィルター')).toBe(true);
    });
  });

  describe('health', () => {
    it('オーラルケア / デンタル系を通す', () => {
      expect(passesTitleWhitelist('health', 'クリニカ デンタルフロス Y字 18本')).toBe(true);
      expect(passesTitleWhitelist('health', 'ライオン 歯磨き粉 チェックアップ')).toBe(true);
    });

    it('シャンプー / ボディソープ系を通す', () => {
      expect(passesTitleWhitelist('health', 'ミノン 全身シャンプー')).toBe(true);
      expect(passesTitleWhitelist('health', 'arau. ベビーハンドソープ')).toBe(true);
    });

    it('サプリ / ビタミン / 健康食品系を通す', () => {
      expect(passesTitleWhitelist('health', 'DHC ビタミンC サプリ 60日分')).toBe(true);
      expect(passesTitleWhitelist('health', 'プロテイン ホエイ 1kg')).toBe(true);
      expect(passesTitleWhitelist('health', '日食 オートミール プレミアム')).toBe(true);
    });

    it('保湿 / 日焼け止め系を通す', () => {
      expect(passesTitleWhitelist('health', 'ニベア ハンドクリーム 大')).toBe(true);
      expect(passesTitleWhitelist('health', '日焼け止め SPF50+ ノンケミカル')).toBe(true);
    });

    it('該当キーワード無しは落とす', () => {
      expect(passesTitleWhitelist('health', 'ガジェット ABC')).toBe(false);
    });

    it('空 title は落とす (whitelist 適用される)', () => {
      expect(passesTitleWhitelist('health', '')).toBe(false);
    });
  });

  describe('food', () => {
    it('「国産」を含む title を通す', () => {
      expect(passesTitleWhitelist('food', '国産レモン果汁 500ml')).toBe(true);
    });

    it('「日本産」「日本製」も通す', () => {
      expect(passesTitleWhitelist('food', '日本産はちみつ 200g')).toBe(true);
      expect(passesTitleWhitelist('food', '日本製醤油 1L')).toBe(true);
    });

    it('該当キーワード無しは落とす', () => {
      expect(passesTitleWhitelist('food', '輸入トマト缶 400g')).toBe(false);
    });
  });

  describe('kitchen', () => {
    it('貝印 / 山崎実業ブランド title を通す', () => {
      expect(passesTitleWhitelist('kitchen', '貝印 包丁 三徳 165mm')).toBe(true);
      expect(passesTitleWhitelist('kitchen', '山崎実業 タワー キッチン収納')).toBe(true);
    });

    it('日本製 / 国産も通す', () => {
      expect(passesTitleWhitelist('kitchen', '日本製ステンレスボウル')).toBe(true);
    });

    it('該当キーワード無しは落とす (「便利」は初回外している)', () => {
      expect(passesTitleWhitelist('kitchen', '便利キッチンツール ABC ブランド')).toBe(false);
    });
  });

  describe('stationery', () => {
    it('SARASA / フリクション (大文字小文字無関係) を通す', () => {
      expect(passesTitleWhitelist('stationery', 'ゼブラ SARASA 0.5mm 黒 10本')).toBe(true);
      expect(passesTitleWhitelist('stationery', 'パイロット FRIXION ボール 0.5')).toBe(true);
      expect(passesTitleWhitelist('stationery', 'pilot frixion ball')).toBe(true);
    });

    it('万年筆・ガラスペン・ハイユニ・パーフェクトペンシルを通す', () => {
      expect(passesTitleWhitelist('stationery', 'パイロット 万年筆 カクノ')).toBe(true);
      expect(passesTitleWhitelist('stationery', 'ガラスペン 国産 セット')).toBe(true);
      expect(passesTitleWhitelist('stationery', '三菱鉛筆 ハイユニ HB 12本')).toBe(true);
      expect(passesTitleWhitelist('stationery', 'パーフェクトペンシル 9000')).toBe(true);
    });

    it('万年筆用「インク」は通す', () => {
      expect(passesTitleWhitelist('stationery', 'パイロット 万年筆インク 30ml')).toBe(true);
    });

    it('プリンタインク / 互換インクは落とす', () => {
      expect(passesTitleWhitelist('stationery', 'プリンタ用インク BCI-381 互換')).toBe(false);
      expect(passesTitleWhitelist('stationery', '互換 インク Brother LC411')).toBe(false);
    });

    it('国産ノートを通す', () => {
      expect(passesTitleWhitelist('stationery', '国産 A5 ノート 5冊セット')).toBe(true);
      expect(passesTitleWhitelist('stationery', 'ノート B5 日本製 横罫')).toBe(true);
    });

    it('無関係 title は落とす', () => {
      expect(passesTitleWhitelist('stationery', '汎用シャープペンシル 0.5mm')).toBe(false);
    });
  });

  describe('pc-desk', () => {
    it('モニターアーム / トラックボール / Thunderbolt 等を通す', () => {
      expect(passesTitleWhitelist('pc-desk', 'エルゴトロン LX モニターアーム シルバー')).toBe(true);
      expect(passesTitleWhitelist('pc-desk', 'Logicool MX ERGO トラックボール')).toBe(true);
      expect(passesTitleWhitelist('pc-desk', 'CalDigit TS4 Thunderbolt 4 ドック')).toBe(true);
      expect(passesTitleWhitelist('pc-desk', 'MacBook Pro 14 USB-C ハブ')).toBe(true);
    });

    it('分離型キーボード / HHKB / REALFORCE を通す', () => {
      expect(passesTitleWhitelist('pc-desk', 'Mistel BAROCCO 分離型キーボード')).toBe(true);
      expect(passesTitleWhitelist('pc-desk', 'HHKB Professional HYBRID Type-S')).toBe(true);
      expect(passesTitleWhitelist('pc-desk', 'REALFORCE R3 静音')).toBe(true);
    });

    it('左手デバイスを通す', () => {
      expect(passesTitleWhitelist('pc-desk', 'TourBox Elite Plus 左手デバイス')).toBe(true);
      expect(passesTitleWhitelist('pc-desk', 'Elgato Stream Deck XL')).toBe(true);
    });

    it('デスクライト / デスク照明を通す', () => {
      expect(passesTitleWhitelist('pc-desk', 'BenQ ScreenBar Halo デスクライト')).toBe(true);
    });

    it('単体「モニター」(誤マッチ抑止のため意図的に除外) は落とす', () => {
      expect(passesTitleWhitelist('pc-desk', 'Dell 27インチ モニター 4K')).toBe(false);
    });

    it('該当キーワード無しは落とす (互換ケーブル等)', () => {
      expect(passesTitleWhitelist('pc-desk', '互換 USB ケーブル 1m 5本')).toBe(false);
      expect(passesTitleWhitelist('pc-desk', '汎用プリンタトナー')).toBe(false);
    });
  });

  describe('audio', () => {
    it('ヘッドホン / イヤホン / スピーカー / DAC を通す', () => {
      expect(passesTitleWhitelist('audio', 'ソニー WH-1000XM5 ヘッドホン')).toBe(true);
      expect(passesTitleWhitelist('audio', 'AirPods Pro 第2世代 イヤホン')).toBe(true);
      expect(passesTitleWhitelist('audio', 'FiiO K7 USB DAC')).toBe(true);
    });

    it('該当無しは落とす', () => {
      expect(passesTitleWhitelist('audio', 'ケーブル 3.5mm 1m')).toBe(false);
    });
  });

  describe('gaming', () => {
    it('日本製 / 国産以外はほぼ落ちる (whitelist が空に近い)', () => {
      expect(passesTitleWhitelist('gaming', 'Nintendo Switch ソフト')).toBe(false);
      expect(passesTitleWhitelist('gaming', '日本製 ゲームパッド')).toBe(true);
    });
  });
});
