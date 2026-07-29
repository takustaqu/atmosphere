[English](README.md) | 日本語

# Atmosphere - 空シミュレーター

**時刻と気象を渡すと、その空を概ね再現できる** レンダラです。
WebGLのフラグメントシェーダ1枚、依存ライブラリなし・DOMにもフレームワークにも依存しません。
実際の動作は `examples/` のサンプルをご覧ください。

```ts
import { Atmosphere } from '@takustaqu/atmosphere';

const sky = new Atmosphere(canvas, {
  time: new Date(),
  location: { latitude: 35.68, longitude: 139.77 },
  weather: { cloudCover: 0.95, precipitation: 12, windSpeed: 18 },
});
```

これで、その日その時刻の東京の、雲量95%・時間雨量12mm・風速18m/s の空が描かれ続けます。
`sky.set({ ... })` で条件を変えると、数秒かけて滑らかにその気象へ遷移します。

元々とあるゲームの個人的な移植を行う中で、追加要素として作ったものとなります。
気象の物理シミュレーションではないため正確性はありませんが、プロシージャルに変化し
続ける空を手軽に使えるものとなっているかと思います。

## 描けるもの

- **時刻** — 空のグラデーション、太陽（輪郭のない白飛びグレア）、
  夕焼け・マジックアワーの藤色、星、月、夜の街明かり
- **十種雲形** — 巻雲・巻層雲・巻積雲・高層雲・高積雲・乱層雲・層雲・層積雲・積雲・積乱雲。
  視線レイと雲平面の交差によるパース投影で、高度ごとに遠近が付きます
- **積乱雲のかなとこ** — 圏界面に達した塔が水平に広がります
- **雲のライティング** — 太陽方向の擬似シェーディング、シルバーライニング、
  連続的な厚みによる青灰色の影、曇天時は拡散光でフラットになります
- **雲の形状進化** — ドメインワープ場自体が動き、雲がその場で湧いて崩れます
- **降水** — 雨（風で傾く）、雪（風に流されて舞う）、レンズに付く水滴
- **荒天** — 稲光、暴風による雲の乱流
- **視程** — 霞・靄・霧。薄いうちは地平線側だけを潰し、濃くなると全天を覆います
- **レンズフレア** — 光軸上のゴースト、色収差、アナモルフィック風のストリーク
- **カラーフィルター** — セピア・モノクローム・青の記憶ほか

## 気象条件の設定

気象は**観測の単位そのまま**で受け取ります。
現実の気象条件と合わせたような指定をする場合、気象情報をそのまま渡しても面白いかもしれません。

| プロパティ | 単位 | 意味 |
|:---|:---|:---|
| `cloudCover` | 0..1 | 全天雲量（オクタ表記なら /8 して渡す）。0 で雲ひとつない空になります |
| `clouds` | — | 十種雲形ごとの量。指定すると `cloudCover` より優先されます |
| `precipitation` | mm/h | 降水強度 |
| `precipitationType` | `'rain'` \| `'snow'` | 降水の種別 |
| `windSpeed` | m/s | 地上風速 |
| `thunder` | 0..1 | 雷の活発さ |
| `visibility` | km | 視程 |
| `convection` | 0..1 | 対流の発達（＝`clouds.cumulonimbus` の省略記法） |

名前付きのプリセットも同じ観測値で定義してあるので、両者は地続きです。

| id | 名前 | 雲量 | 降水 | 風速 | 視程 | 雷 |
|:---|:---|--:|--:|--:|--:|--:|
| `clear` | 快晴 | 0 | — | 2 | 45 | — |
| `fair` | 晴れ | 0.22 | — | 3 | 35 | — |
| `summer` | 夏空 | 0.38 | — | 3 | 25 | — |
| `overcast` | 曇り | 0.82 | — | 5 | 15 | — |
| `fog` | 霧 | 0.75 | — | 1 | 0.6 | — |
| `rain` | 雨 | 0.95 | 8 | 7 | 8 | 0.08 |
| `thunderstorm` | 雷雨 | 0.97 | 25 | 12 | 5 | 1.0 |
| `snow` | 雪 | 0.90 | 3 (雪) | 3 | 4 | — |
| `typhoon` | 台風 | 1.0 | 40 | 30 | 6 | 0.5 |

```ts
sky.set({ weather: 'typhoon' });                       // プリセット
sky.set({ weather: { cloudCover: 0.4, windSpeed: 9 } });  // 観測値
```

## 雲を渡す — 十種雲形

雲量ひとつでは「どんな雲か」は決まりません。同じ雲量8割でも、ひつじ雲の空と
のっぺりした雨雲の空はまるで違います。空には複数の雲形が同時に見えるので、
「主役をひとつ選ぶ」のではなく、**雲形ごとの量 0..1 を重ねます**。

```ts
sky.set({ weather: { clouds: { cirrus: 0.5, cumulus: 0.3 } } });  // 巻雲の下に綿雲
sky.set({ weather: { clouds: ['altocumulus'] } });                // ひつじ雲だけの空
```

| id | 和名 | 通称 | 高度 | 形態 |
|:---|:---|:---|:---|:---|
| `cirrus` | 巻雲 | すじ雲 | 上層 | 繊維状 |
| `cirrostratus` | 巻層雲 | うす雲 | 上層 | 層状（太陽に暈が出る） |
| `cirrocumulus` | 巻積雲 | うろこ雲・いわし雲 | 上層 | 粒状（細かい） |
| `altostratus` | 高層雲 | おぼろ雲 | 中層 | 層状 |
| `altocumulus` | 高積雲 | ひつじ雲 | 中層 | 粒状（中） |
| `nimbostratus` | 乱層雲 | あま雲 | 中層 | 層状（濃灰色・雨） |
| `stratus` | 層雲 | きり雲 | 下層 | 層状（低く垂れこめる） |
| `stratocumulus` | 層積雲 | くもり雲 | 下層 | 粒状（大・ロール状） |
| `cumulus` | 積雲 | わた雲 | 下層 | 対流塊 |
| `cumulonimbus` | 積乱雲 | 入道雲 | 下層 | 対流塊（かなとこ付き） |

`clouds` を渡さないときは、雲量・降水・対流・視程から妥当な雲形構成が組み立てられます
（`defaultCloudMix`）。気象APIが返すのは雲量であって雲形ではないので、素通しの経路は
こちらが受けます。「雲が少なければ綿雲と巻雲、増えれば層積雲と高層雲、降れば乱層雲」
という、ごく普通の空の成り立ちをなぞっています。

## 時刻と場所

`time` は `0..24` の数値・`Date`・`"14:30"`・ISO文字列のいずれでも構いません。

`location`（緯度経度）を併せて渡すと、`Date` から**実際の太陽位置**（方位角・高度）を
NOAA の式で計算します。緯度が変われば南中高度が変わり、季節が変われば日の長さが変わります。

```ts
sky.set({ time: '2026-12-21T16:00Z', location: { latitude: 64.1, longitude: -21.9 } });
// レイキャビクの冬至の16時 → もう夜
```

`location` を渡さないときは「6時に東から昇り、12時に南中し、18時に西へ沈む、
どこでもない北半球の中緯度」で代替します（南中高度46°）。

### タイムゾーン

タイムゾーンのパラメータはありません。`location` もタイムゾーンではありません。
緯度経度が決めるのは空のどこに太陽があるかであって、渡した `time` がどの時計の
時刻なのかについては何も言いません。

`Date` は絶対時刻ですので、そこから求めた太陽位置はどの環境で動かしても正しくなります。
それ以外は**実行環境の**ローカルタイムゾーンで解釈されます。オフセットのない ISO 文字列
（`'2026-07-26T14:30'`）は観測地ではなく実行環境のローカル時刻として読まれますし、
時刻も実行環境の時計から取ります。

ですので、ロンドンのマシンから*東京の*14:30 を描くときはオフセットを明示してください。

```ts
sky.set({ time: '2026-07-26T14:30+09:00', location: { latitude: 35.68, longitude: 139.77 } });
```

`new Date()` については何も気にする必要はありません。今この瞬間はどこでも今この瞬間です。

## カラーフィルター

輝度に落としてから任意の色に染め直す、フィルム的なグレーディングです。
セピアはそのプリセットのひとつでしかありません。

| id | 名前 | 用途 |
|:---|:---|:---|
| `none` | なし | |
| `sepia` | セピア | 回想 |
| `mono` | モノクローム | 完全な無彩色 |
| `faded` | 褪色 | 彩度を少し残し、黒を持ち上げたローコントラスト |
| `cyanotype` | 青の記憶 | 青写真調の寒色モノトーン |
| `gold` | 黄昏 | 暖色に寄せた金色調 |
| `ash` | 灰 | わずかに青みのある灰 |

```ts
sky.set({ filter: 'cyanotype' });                     // 全掛け
sky.set({ filter: { id: 'sepia', amount: 0.6 } });    // 薄く
sky.set({ filter: { tint: [1.1, 0.9, 1.0], saturation: 0.2, lift: 0.05 } });  // 自前の色
```

フィルターの切り替えも色ごと補間されるので、セピア → 青の記憶が滑らかに繋がります。

## カメラ / スカイボックス

描画はすべて**カメラから伸ばした視線レイ**で行われます。空の色・雲・太陽・月・星は
「その方向に何が見えるか」として解かれていて、スクリーン空間に残っているのは
レンズ側の現象（水滴・フレア・ビネット）だけです。

```ts
sky.set({ camera: { yaw: Math.PI / 2 } });   // 東を向く。太陽の位置も雲の流れも追随する
```

`yaw` は方位角（北=0、東=π/2）、`pitch` は仰角、`fov` は垂直画角です。既定は
「南を向いて仰角26°・画角49°」＝地平線が画面下端のすぐ外に来る背景向けの構えになっています。

`fov` を90°にして6方向を描けばキューブマップになります。その6面ぶんのカメラは
`CUBE_FACE_CAMERAS` にあります。

```ts
import { AtmosphereRenderer, CUBE_FACE_CAMERAS, resolveConditions } from '@takustaqu/atmosphere';

const renderer = new AtmosphereRenderer(canvas);   // 正方形の canvas
const state = resolveConditions({ time: 16.5, weather: 'summer' });
renderer.resize(512, 512);
for (const face of CUBE_FACE_CAMERAS) {
  renderer.render(0, state, face);
  // gl.readPixels なり toDataURL なりで焼く
}
```

このループを1行で済ませるのが `renderCubeFaces` です。

```ts
import { renderCubeFaces } from '@takustaqu/atmosphere';

const faces = renderCubeFaces({ time: 16.5, weather: 'summer' }, { size: 512 });
```

`CUBE_FACE_CAMERAS` の順（+X 東・-X 西・+Y 天頂・-Y 天底・+Z 北・-Z 南）で、
正方形の2D canvas を6枚返します。そのまま `drawImage` や `toDataURL`、
キューブマップ面へのアップロードに使えます。呼び出しごとに使い捨ての WebGL
コンテキストを作って破棄するので、毎フレーム呼ぶものではなくシーン切替時の
ベイク用です（WebGL非対応の環境では throw します）。

## モーション低減

全画面の背景が動き続けるのは前庭障害のある方にはつらいので、既定で
`prefers-reduced-motion: reduce` を尊重します。reduce のとき `start()` は
ループせず静止画を1フレームだけ描き、`set()` はトランジション無しのカットで
反映されます。メディアクエリの変化にも追従するので、OSの設定を切り替えれば
その場でループが止まり、また動き出します。

```ts
const sky = new Atmosphere(canvas, { respectReducedMotion: false });  // 設定によらず動かし続ける
sky.reducedMotion;   // 静止させている間は true
```

## API

| export | 役割 |
|:---|:---|
| `Atmosphere` | canvas + レンダラ + 描画ループ。`set()` / `jump()` / `start()` / `stop()` / `dispose()` |
| `AtmosphereRenderer` | 1回の `render()` が1枚。自前のループやオフスクリーン描画向け |
| `StateAnimator` | 目標への追従と、風・形状進化の積分。DOM非依存 |
| `resolveConditions(c)` | `Conditions` → `AtmosphereState` |
| `resolveWeather(w)` | 観測値・プリセット → 0..1 のパラメータ |
| `resolveClouds(c)` / `defaultCloudMix(...)` | 雲形の解決と、雲量からの自動展開 |
| `CLOUD_GENERA` | 十種雲形のメタ情報（英名・通称・高度・形態） |
| `resolveFilter(f)` | フィルター指定の解決 |
| `solarPosition(date, loc)` | 緯度経度と日時から太陽の方位角・高度 |
| `WEATHER_PRESETS` / `FILTER_PRESETS` | プリセット |
| `DEFAULT_CAMERA` / `CUBE_FACE_CAMERAS` | カメラ |
| `renderCubeFaces(c, opts)` | スカイボックス6面を一発でベイクし、2D canvas で返す |
| `formatTod(tod)` | `14.5` → `"14:30"` |
| `weatherLabel(id, locale)` / `filterLabel(id, locale)` / `cloudGenusLabel(id, locale)` | ラベルの多言語化（`'en'` / `'ja'`） |

`Atmosphere` を使わず、自前の描画ループに組み込む場合は次のようにします。

```ts
const renderer = new AtmosphereRenderer(canvas);   // WebGL非対応なら renderer.available === false
const anim = new StateAnimator(resolveConditions({ time: 14, weather: 'summer' }));

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.2, (now - last) / 1000); last = now;
  anim.step(resolveConditions({ time: 23, weather: 'typhoon' }), dt);   // 目標を毎フレーム渡す
  renderer.render(now / 1000, anim.current, DEFAULT_CAMERA, anim.wind, anim.evolution);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## 多言語対応

コア（`CLOUD_GENERA` / `WEATHER_PRESETS` / `FILTER_PRESETS`）の `label` / `alias` は英語です。
日本語ラベルは `weatherLabel(id, 'ja')` / `filterLabel(id, 'ja')` / `cloudGenusLabel(id, 'ja')`
（`src/i18n.ts`）から引けます。

```ts
import { weatherLabel, cloudGenusLabel } from '@takustaqu/atmosphere';

weatherLabel('typhoon', 'ja');           // '台風'
cloudGenusLabel('cumulonimbus', 'ja');   // { label: '積乱雲', alias: '入道雲' }
```

`examples/react/AtmosphereControls` は `locale` プロパティ（既定 `'en'`）でこれを切り替えます。

## サンプル

`examples/` はレンダラの使用例であって、atmosphere の一部ではありません。
気に入らなければコピーして書き換えるのが早いです。

### React

```tsx
import { AtmosphereCanvas } from '@takustaqu/atmosphere/react';
import '@takustaqu/atmosphere/react/styles.css';

<AtmosphereCanvas time={new Date()} weather="rain" filter="sepia" />
```

動作確認用の設定パネル `AtmosphereControls` も同梱しています。

### 気象コントローラー

```bash
pnpm playground   # → http://localhost:8791/examples/controller/
```

全パラメータを手で動かすサンプルです。**キャンバスをドラッグすると視点が回り、ホイールで画角が変わります。**
描画が視線レイ基準なので、これは平面の背景ではなく、その場に張られたスカイボックスを
内側から見回している状態そのものです。「6面を焼く」を押すと、同じ空がその場でキューブマップに落ちます。

観測値がレンダラ向けの 0..1 にどう解決されたかを常時表示するので、
`cloudCover` や `visibility` が何に効くのかを見ながら確かめられます。

### playground

```bash
pnpm playground   # → http://localhost:8791/examples/playground/
```

条件を並べたコンタクトシートです。`?sheet=time | weather | genus | sparse | tower | filter | location | camera`、
動くデモは `?sheet=grow`（積乱雲が湧いて、かなとこを張り、崩れるまでを40秒で繰り返します）、
実写と突き合わせるベンチマークは `?sheet=nimbostratus | altostratus | cumulonimbus`
で並べる軸を切り替えられます。見た目を変えたあとの回帰確認はこれを見るのが早いです。

## 設計メモ

- **太陽・カメラは方向で持ち、視線レイ基準で解く。** 太陽は方位角・高度で扱う。緯度経度からの
  実太陽位置がそのまま渡せ、カメラをどちらへ向けても破綻しない。空の色も仰角の関数として
  視線レイから求めるので、「画面の上端＝天頂」という前提が要らない。
- **風と形状進化は積分で進める。** 「経過時間 × 風速」で位置を出すと、天候変化で風速が変わった
  瞬間にオフセットが飛んで雲がワープする。毎フレーム `位置 += 風速 × dt` を積算すれば、風速が
  変わってもオフセットは連続。時刻を動かした分だけ雲も流れ、天候だけ変えたときは雲がその場で変質する。
- **荒天は雨・雪・風・雷に分解して持つ。** 独立させることで、無風の大雨も、雨の降らない暴風も
  描ける。空の暗さと雲の乱れはそこから導出する。
- **十種雲形は「4形態 × 3高度」に還元する。** 実際に違うのは繊維状・層状・粒状・対流塊の4形態と、
  高度（雲平面の投影スケール）だけ。
- **積乱雲の輪郭は2次元の場、1本の式で決める。** 方位ごとに高さを1つ決める1次元プロファイルでは
  三角形の山にしかならない。方位角と仰角の2次元場にし、「勢い − 高さ」の式でしきい値の内外を
  決めると、上ほど自然に細くなり頂上が丸くなる。方位方向の山を尖らせれば、高さを保ったまま
  上へすぼまる。
- **丸い房は球の和で作り、高周波を別に足す。** ノイズのしきい値切りは境界がどのスケールでも
  フラクタルになり、丸い房にはならない。ジッタした球の和なら境界は円弧になる。ただし球の和には
  高周波成分がないので、細部は別にノイズを重ねる。最低3段。薄く水平な派生形（かなとこ・ベール）は
  仰角の帯ではなく、塊を縦に潰した場として作る（帯は縁をどれだけほつれさせても構造として線にしかならない）。
- **陰影の信号は飽和させず、色のマッピング側でコントラストを作る。** ゲインを上げて `clamp(±1)`
  すると面の向きが2値になり、色も2色になる。信号は連続量のまま小さく保ち、白・中間・影の3点を
  広い `smoothstep` で渡り歩かせる。実写に寄せてコントラストを上げすぎると「押し当てた切り抜き」に
  見えるので、背景用途では迷ったら弱いほうを採る。
- **降水は「粒」ではなく「視界の喪失」として効かせる。** 粒だけ描くと「白い点が舞う晴れた空」に
  なる。粒の大きさ・間隔は奥行きに沿って連続的に散らさないと作り物に見える。量0の雲形は丸ごと
  スキップし、既定は軽量（30fps・解像度0.55倍）に保つ。

## 積乱雲の派生形

かなとこ雲とベール雲は、十種雲形ではなく積乱雲に付随する形なので `features` で持ちます。
省略すると `cumulonimbus` の発達度から自動で決まります（ベール雲は伸び盛りに付き、
成熟してかなとこが張ると目立たなくなります）。

```ts
sky.set({ weather: {
  clouds: { cumulonimbus: 0.9 },
  features: { anvil: 1, velum: 0.3 },   // 明示指定
}});
```

この2つは見た目の作りが根本的に違います。かなとこ雲は**氷晶**なのでカリフラワーの粒立ちを
持たず、絹のような横筋になり、風下へ大きく張り出します。ベール雲は**水滴**なので繊維を持たず、
塔の中腹にのっぺり白い一枚として掛かります。

## 未実装

- 月相・月の軌道（いまは太陽の正反対・仰角35°に固定した満月です）
- そのほかの変種・派生形（レンズ雲、穴あき雲、乳房雲、笠雲など）
- 大気散乱の物理モデル（レイリー/ミー散乱ではなく、色の手付けです）
- 気温・湿度・気圧そのものを反映する経路（いまは視程と雲量が受け皿になっています）

## 配布形態

ビルド成果物ではなく **TypeScriptソースをそのまま公開**しています
（`exports` が `src/*.ts` を指します）。Vite などのバンドラ前提です。
`pnpm typecheck` で型だけ検査できます。

## ライセンス

MITライセンスです。
詳細は [LICENSE](LICENSE) を参照してください。
