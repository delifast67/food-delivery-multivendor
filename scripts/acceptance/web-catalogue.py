"""Recette Web/API/Mongo jetables, réseau extérieur interdit par le lanceur."""
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base, result_path, fixture_path, executable = sys.argv[1:]
fixture = json.loads(Path(fixture_path).read_text())
out = Path(result_path).parent
out.mkdir(parents=True, exist_ok=True)
expect.set_options(timeout=15000)
checks = []
def checked(label):
    checks.append(label)
    print('OK — ' + label, flush=True)

def rows(page):
    # Les catégories restent explicitement hors pagination de ce lot.
    return page.locator('div.df-menu-admin > article.df-catalogue-item')

def row_for(page, text):
    return rows(page).filter(has=page.locator('strong', has_text=re.compile('^' + re.escape(text) + '$')))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable or None,
        args=['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'])
    context = browser.new_context(viewport={'width':1280,'height':900}, service_workers='block')
    external, errors, summaries, menu_pages, menu_details, profiles, legacy, mutations = [], [], [], [], [], [], [], []
    state = {'fail_create_read': False, 'lost_archive': False, 'conflict': False}
    def guard(route):
        if route.request.url.startswith(base + '/') or route.request.url.startswith(('data:', 'blob:')):
            route.continue_()
        else:
            external.append(route.request.url)
            route.abort('blockedbyclient')
    context.route('**/*', guard)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    def track(route):
        body = json.loads(route.request.post_data or '{}')
        query = body.get('query', '')
        assert 'availableRiders' not in query
        if 'operationsRestaurantSummaries(' in query:
            response = route.fetch(); payload = response.json()
            assert not payload.get('errors'), payload
            value = payload['data']['operationsRestaurantSummaries']
            assert len(value['items']) <= 20
            assert all(set(item) == {'id','name','open','version'} for item in value['items'])
            assert 'menu' not in query and 'categories' not in query
            summaries.append((body, value)); route.fulfill(response=response)
        elif 'operationsMenuItemSummaries(' in query:
            if state['fail_create_read']:
                state['fail_create_read'] = False
                route.abort('failed'); return
            response = route.fetch(); payload = response.json()
            assert not payload.get('errors'), payload
            value = payload['data']['operationsMenuItemSummaries']
            assert len(value['items']) <= 20
            assert all(set(item) == {'id','name','priceXof','available','archived','version','categoryId'} for item in value['items'])
            assert 'description' not in query and 'optionGroups' not in query
            assert len(response.body()) < 12000
            menu_pages.append((body, value)); route.fulfill(response=response)
        elif 'operationsRestaurant(id:' in query:
            response = route.fetch(); payload = response.json()
            assert not payload.get('errors'), payload
            assert payload['data']['operationsRestaurant'] is None or 'menu' not in payload['data']['operationsRestaurant']
            profiles.append(body); route.fulfill(response=response)
        elif re.search(r'\boperationsRestaurants\s*\{', query):
            legacy.append(body); route.fallback()
        elif 'operationsMenuItem(restaurantId:' in query:
            response = route.fetch(); payload = response.json()
            assert not payload.get('errors'), payload
            value = payload['data']['operationsMenuItem']
            assert value is None or {'id','name','description','priceXof','available','archived','version','categoryId','optionGroups'} <= set(value)
            menu_details.append((body, value)); route.fulfill(response=response)
        else:
            if any(name in query for name in ('setRestaurantOpen(', 'setMenuItemArchived(', 'updateMenuItem(', 'createMenuItem(')):
                mutations.append(body)
                if 'setRestaurantOpen(' in query: assert 'menu' not in query
                if 'createMenuItem(' in query: state['fail_create_read'] = True
                if 'setMenuItemArchived(' in query and state['conflict']:
                    state['conflict'] = False
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'errors':[{'message':'Conflit fixture','extensions':{'code':'CONCURRENT_MODIFICATION'}}]})); return
                if 'setMenuItemArchived(' in query and state['lost_archive']:
                    state['lost_archive'] = False
                    response = route.fetch()
                    assert not response.json().get('errors')
                    route.abort('failed'); return
            route.fallback()
    page.route('**/api/delifast/graphql', track)
    def login(email, password):
        page.goto(base + '/delifast/operations')
        page.get_by_label('Email', exact=True).fill(email)
        page.get_by_label('Mot de passe', exact=True).fill(password)
        page.get_by_role('button', name='Se connecter', exact=True).click()
        expect(page.get_by_role('heading', name='Commandes', exact=True)).to_be_visible()
        page.get_by_role('tab', name='Catalogue', exact=True).click()
        expect(page.get_by_role('heading', name='Plats, catégories et options', exact=True)).to_be_visible()
    login('admin@delifast.local', 'AdminDemo!2026')
    catalogue = page.locator('.df-catalogue')
    select = catalogue.get_by_label('Choisir un restaurant', exact=True)
    refresh = catalogue.get_by_role('button', name='Actualiser', exact=True)
    def settled():
        expect(refresh).to_be_enabled()
        expect(catalogue.get_by_role('button', name='Rechercher le restaurant', exact=True)).to_be_enabled()
    expect(select).to_be_enabled()
    def restaurant_ids():
        return select.locator('option').evaluate_all('(nodes) => nodes.map(n => n.value).filter(Boolean)')
    assert len(restaurant_ids()) == 20
    restaurant_pages = [set(restaurant_ids())]
    next_rest = catalogue.get_by_role('button', name='Restaurants suivants', exact=True)
    prev_rest = catalogue.get_by_role('button', name='Restaurants précédents', exact=True)
    while next_rest.is_enabled():
        next_rest.click(); settled()
        current = set(restaurant_ids()); assert current and len(current) <= 20
        assert set.union(*restaurant_pages).isdisjoint(current); restaurant_pages.append(current)
    assert len(set.union(*restaurant_pages)) == 66
    prev_rest.click(); settled(); assert set(restaurant_ids()) == restaurant_pages[-2]
    checked('66 restaurants parcourus sans doublon, pages de 20 et retour précédent exact')
    exact = catalogue.get_by_label('ID restaurant exact', exact=True)
    before = len(summaries); exact.fill(fixture['restaurantId']); assert len(summaries) == before
    catalogue.get_by_role('button', name='Rechercher le restaurant', exact=True).click(); settled()
    assert restaurant_ids() == [fixture['restaurantId']]
    assert summaries[-1][0]['variables']['restaurantId'] == fixture['restaurantId']
    expect(catalogue.locator('.df-catalogue-status strong')).to_have_text('Restaurant Web 064')
    expect(row_for(page, 'Plat z-web-restaurant-064 001')).to_be_visible()
    assert not menu_details and not legacy
    catalogue.get_by_role('button', name='Fermer le restaurant', exact=True).click()
    expect(catalogue.get_by_text('Restaurant fermé.', exact=True)).to_be_visible()
    checked('Recherche restaurant exacte sans appel pendant la saisie, profil et ouverture sans menu embarqué')
    menu_select = catalogue.get_by_label('ID plat exact', exact=True)
    menu_next = catalogue.get_by_role('button', name='Plats suivants', exact=True)
    menu_prev = catalogue.get_by_role('button', name='Plats précédents', exact=True)
    seen, menu_page_sets = set(), []
    while True:
        current = set(rows(page).locator('strong').all_text_contents())
        assert 0 < len(current) <= 20 and not seen.intersection(current)
        seen |= current; menu_page_sets.append(current)
        if not menu_next.is_enabled(): break
        menu_next.click(); settled()
    assert len(menu_page_sets) == 7 and len(seen) == 130
    menu_prev.click(); settled()
    assert set(rows(page).locator('strong').all_text_contents()) == menu_page_sets[-2]
    checked('130 plats sur sept pages sans doublon, résumés seuls, retour précédent exact et 20 lignes maximum')
    target_item = 'z-web-restaurant-064-item-001'
    before = len(menu_pages); menu_select.fill(target_item); assert len(menu_pages) == before
    catalogue.get_by_role('button', name='Rechercher le plat', exact=True).click(); settled()
    expect(rows(page)).to_have_count(1)
    assert menu_pages[-1][0]['variables']['menuItemId'] == target_item
    row_for(page, 'Plat z-web-restaurant-064 001').get_by_role('button', name='Modifier', exact=True).click()
    expect(catalogue.get_by_role('heading', name='Modifier le plat', exact=True)).to_be_visible()
    assert len(menu_details) == 1
    assert catalogue.get_by_label('Catégorie du plat', exact=True).input_value() == 'cat-web-064'
    assert catalogue.get_by_label('Nom du groupe 1', exact=True).input_value() == 'Accompagnement'
    description = catalogue.locator('textarea').input_value()
    catalogue.get_by_label('Nom', exact=True).fill('Plat 064 modifié')
    catalogue.get_by_role('button', name=re.compile(r'Enregistrer \(version')).click()
    expect(catalogue.get_by_text('Plat modifié.', exact=True)).to_be_visible()
    assert mutations[-1]['variables']['expectedVersion'] == 0
    assert mutations[-1]['variables']['input']['description'] == description
    assert mutations[-1]['variables']['input']['categoryId'] == 'cat-web-064'
    assert mutations[-1]['variables']['input']['optionGroups'][0]['options'][0]['available'] is True
    checked('Recherche plat hors page, détail au seul clic Modifier, description/catégorie/options et CAS préservés')
    reset_menu = catalogue.get_by_role('button', name='Réinitialiser les plats', exact=True)
    reset_menu.click(); settled(); expect(rows(page)).to_have_count(20)
    catalogue.get_by_label('Nom', exact=True).fill('Plat créé recette')
    catalogue.locator('textarea').fill('Description créée par la recette')
    catalogue.get_by_label('Prix (XOF)', exact=True).fill('2222')
    catalogue.get_by_role('button', name='Créer le plat', exact=True).click()
    expect(catalogue.get_by_text(re.compile('Issue de l’écriture incertaine'))).to_be_visible()
    assert len([m for m in mutations if 'createMenuItem(' in m['query']]) == 1
    expect(rows(page)).to_have_count(0)
    refresh.click(); settled(); expect(catalogue.get_by_role('alert')).to_have_count(0)
    expect(rows(page)).to_have_count(20)
    checked('Création persistée, échec de relecture sans rejeu ni 21e ligne, récupération explicite bornée')
    state['lost_archive'] = True
    archive = row_for(page, 'Plat z-web-restaurant-064 003').get_by_role('button', name='Archiver', exact=True)
    archive.evaluate('(node) => { node.click(); node.click(); }')
    expect(catalogue.get_by_text(re.compile('Issue de l’écriture incertaine'))).to_be_visible()
    archive_count = len([m for m in mutations if 'setMenuItemArchived(' in m['query']])
    assert archive_count == 1
    menu_next.click(); settled()
    assert rows(page).get_by_role('button', name='Archiver', exact=True).count() > 0
    assert rows(page).get_by_role('button', name='Archiver', exact=True).first.is_disabled()
    menu_prev.click(); settled()
    assert len([m for m in mutations if 'setMenuItemArchived(' in m['query']]) == archive_count
    refresh.click(); settled(); expect(catalogue.get_by_role('alert')).to_have_count(0)
    row2 = row_for(page, 'Plat z-web-restaurant-064 002')
    row2.get_by_role('button', name='Archiver', exact=True).click()
    expect(catalogue.get_by_text('Plat archivé.', exact=True)).to_be_visible()
    row2.get_by_role('button', name='Restaurer', exact=True).click()
    expect(catalogue.get_by_text('Plat restauré.', exact=True)).to_be_visible()
    checked('Réponse archive perdue après persistance, double clic unique, navigation sans réarmement et archive/restauration CAS')
    menu_next.click(); settled()
    last_variables = menu_pages[-1][0]['variables']
    state['conflict'] = True
    before = len(mutations)
    rows(page).get_by_role('button', name='Archiver', exact=True).first.click()
    expect(catalogue.get_by_text(re.compile('Ce catalogue a été modifié ailleurs'))).to_be_visible()
    assert len(mutations) == before + 1
    assert menu_pages[-1][0]['variables'] == last_variables
    checked('Conflit hors première page : curseur et filtre conservés, relecture sans rejeu')
    reset_menu.click(); settled()
    def absent_detail(route):
        body = json.loads(route.request.post_data or '{}')
        if 'operationsMenuItem(' in body.get('query',''):
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'data':{'operationsMenuItem':None}}))
        else: route.fallback()
    page.route('**/api/delifast/graphql', absent_detail)
    row_for(page, 'Plat z-web-restaurant-064 004').get_by_role('button', name='Modifier', exact=True).click()
    expect(catalogue.get_by_role('alert')).to_be_visible()
    expect(catalogue.get_by_role('heading', name='Modifier le plat', exact=True)).to_have_count(0)
    assert catalogue.get_by_label('Nom', exact=True).input_value() == ''
    page.unroute('**/api/delifast/graphql', absent_detail)
    def failed_menu_page(route):
        body = json.loads(route.request.post_data or '{}')
        if 'operationsMenuItemSummaries(' in body.get('query', ''): route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', failed_menu_page)
    reset_menu.click(); settled()
    expect(catalogue.get_by_role('alert')).to_be_visible(); expect(rows(page)).to_have_count(0)
    page.unroute('**/api/delifast/graphql', failed_menu_page)
    reset_menu.click(); settled(); expect(rows(page)).to_have_count(20)
    checked('Détail absent et erreur de page retirent formulaires/lignes périmés, reprise explicite')
    page.set_viewport_size({'width':390,'height':844})
    catalogue.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    screenshot = out / 'web-menu-catalogue-390.png'
    page.screenshot(path=str(screenshot), full_page=True)
    checked('Catalogue admin à 390 px sans débordement')
    page.set_viewport_size({'width':1280,'height':900})
    page.get_by_role('button', name='Se déconnecter', exact=True).click()
    expect(page.get_by_role('heading', name='Connexion équipe', exact=True)).to_be_visible()
    counts = (len(summaries), len(menu_pages), len(menu_details), len(profiles))
    login('restaurant1@delifast.local', 'RestaurantDemo!2026')
    expect(catalogue.locator('.df-catalogue-status strong')).to_have_text('Restaurant fixture catalogue')
    expect(catalogue.get_by_label('Choisir un restaurant', exact=True)).to_have_count(0)
    expect(catalogue.get_by_role('button', name='Fermer le restaurant', exact=True)).to_be_visible()
    expect(row_for(page, 'Plat fixture catalogue')).to_be_visible()
    assert (len(summaries), len(menu_pages), len(menu_details), len(profiles)) == counts
    assert len(legacy) == 1
    page.get_by_role('button', name='Se déconnecter', exact=True).click()
    expect(page.get_by_role('heading', name='Connexion équipe', exact=True)).to_be_visible()
    checked('Rôle restaurant legacy et catalogue autorisé conservés, aucune API admin supplémentaire, logout')
    assert not external, external
    assert not errors, errors
    checked('Aucun appel externe ni erreur JavaScript, aucune commande/paiement/SMS')
    Path(result_path).write_text(json.dumps({'restaurantId': fixture['restaurantId'], 'checks': checks, 'restaurantPages': len(restaurant_pages), 'menuPages': len(menu_page_sets), 'menuDetails': len(menu_details), 'mutations': len(mutations), 'screenshots': [str(screenshot)]}, ensure_ascii=False, indent=2))
    browser.close()
